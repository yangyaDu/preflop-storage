//! Native Rust addon for the Preflop Storage query hot-path.
//!
//! Exports:
//!   - `DimensionHandle` — mmap-backed .idx + .bin reader with query methods.
//!   - `PackDecodeResult` / `DecodedCellResult` / `BatchQueryRequest` — JS types.

mod bin_reader;
mod crc32c;
mod idx_reader;
mod pack_codec;
mod types;

use std::path::Path;

use napi_derive::napi;

use crate::bin_reader::BinReader;
use crate::crc32c::assert_crc32c;
use crate::idx_reader::IdxReader;
use crate::pack_codec::{action_count_from_pack, decode_pack_for_hand};
use crate::types::{BatchQueryRequest, IdxRecord, PackDecodeResult};

/// A dimension handle that combines .idx and .bin file access.
///
/// On construction, both files are mmap'd and validated. All query methods
/// are synchronous and zero-copy — pack data is read directly from the mmap.
#[napi]
pub struct DimensionHandle {
    idx: IdxReader,
    bin: BinReader,
}

#[napi]
impl DimensionHandle {
    /// Create a new DimensionHandle by opening and mmap'ing the .idx and .bin files.
    ///
    /// Validates both file headers (PFXI magic for .idx, PFSP magic for .bin).
    /// Throws a JS Error on invalid paths or unsupported formats.
    #[napi(constructor)]
    pub fn new(idx_path: String, bin_path: String) -> napi::Result<Self> {
        let idx = IdxReader::open(Path::new(&idx_path)).map_err(|e| {
            napi::Error::from_reason(format!(
                "Failed to open .idx file '{}': {}",
                idx_path, e
            ))
        })?;

        let bin = BinReader::open(Path::new(&bin_path)).map_err(|e| {
            napi::Error::from_reason(format!(
                "Failed to open .bin file '{}': {}",
                bin_path, e
            ))
        })?;

        Ok(Self { idx, bin })
    }

    /// Return the number of records in the .idx file.
    #[napi]
    pub fn record_count(&self) -> u32 {
        self.idx.record_count()
    }

    /// Query a single (concreteLineId, handId) pair.
    ///
    /// Returns `null` if the concreteLineId is not found or the handId is not
    /// present in the pack. When `verify_checksum` is true, the pack CRC32C
    /// is validated before decoding.
    #[napi]
    pub fn query(
        &self,
        concrete_line_id: u32,
        hand_id: u32,
        verify_checksum: Option<bool>,
    ) -> Option<PackDecodeResult> {
        let verify = verify_checksum.unwrap_or(false);
        self.query_inner(concrete_line_id, hand_id as u8, verify)
    }

    /// Batch query multiple (concreteLineId, handId) pairs.
    ///
    /// Returns an array of the same length as `requests`. Each element is
    /// `null` if the corresponding concreteLineId is not found or the handId
    /// is not in the pack.
    #[napi]
    pub fn query_batch(
        &self,
        requests: Vec<BatchQueryRequest>,
        verify_checksum: Option<bool>,
    ) -> Vec<Option<PackDecodeResult>> {
        let verify = verify_checksum.unwrap_or(false);
        requests
            .into_iter()
            .map(|req| self.query_inner(req.concrete_line_id, req.hand_id as u8, verify))
            .collect()
    }

    /// Lightweight batch: return only action cell counts per request.
    ///
    /// Much faster than `query_batch` because it avoids serializing individual
    /// DecodedCellResult objects across the napi boundary.
    /// Returns `null` for a request if the concreteLineId/handId is not found.
    #[napi]
    pub fn query_batch_count(
        &self,
        requests: Vec<BatchQueryRequest>,
    ) -> Vec<Option<u32>> {
        requests
            .into_iter()
            .map(|req| {
                self.query_inner(req.concrete_line_id, req.hand_id as u8, false)
                    .map(|result| result.cells.len() as u32)
            })
            .collect()
    }
}

impl DimensionHandle {
    /// Core query logic shared by `query` and `query_batch`.
    fn query_inner(
        &self,
        concrete_line_id: u32,
        hand_id: u8,
        verify_checksum: bool,
    ) -> Option<PackDecodeResult> {
        // Step 1: binary search in .idx
        let record: IdxRecord = self.idx.find(concrete_line_id)?;

        // Step 2: read pack data from .bin (zero-copy slice of mmap)
        let pack = self.bin.read_pack(record.offset, record.byte_length);

        // Step 3: optional CRC32C checksum verification
        if verify_checksum {
            if assert_crc32c(pack, record.checksum).is_err() {
                // In production, we could return an error, but to match the
                // existing JS API (which returns null on error), we return None.
                // The caller can opt into verification separately.
                return None;
            }
        }

        // Step 4: compute action_count from pack dimensions
        let action_count = action_count_from_pack(record.hand_count, record.byte_length);

        // Step 5: decode cells for the target hand_id
        let cells = decode_pack_for_hand(pack, record.hand_count, action_count, hand_id);

        if cells.is_empty() {
            return None;
        }

        Some(PackDecodeResult {
            action_schema_id: record.action_schema_id,
            cells,
        })
    }
}
