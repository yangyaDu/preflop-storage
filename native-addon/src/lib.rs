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

use std::io;
use std::path::Path;

use napi_derive::napi;

use crate::bin_reader::BinReader;
use crate::crc32c::assert_crc32c;
use crate::idx_reader::IdxReader;
use crate::pack_codec::{action_count_from_pack, decode_pack_for_hand, pack_byte_length};
use crate::types::{BatchQueryRequest, DecodedCellResult, IdxRecord, PackDecodeResult};

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
        let idx = IdxReader::open(Path::new(&idx_path))
            .map_err(|e| native_open_error(".idx", &idx_path, e))?;

        let bin = BinReader::open(Path::new(&bin_path))
            .map_err(|e| native_open_error(".bin", &bin_path, e))?;

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
    ) -> napi::Result<Option<PackDecodeResult>> {
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
    ) -> napi::Result<Vec<Option<PackDecodeResult>>> {
        let verify = verify_checksum.unwrap_or(false);
        requests
            .into_iter()
            .map(|req| self.query_inner(req.concrete_line_id, req.hand_id as u8, verify))
            .collect()
    }

    /// Return the unique action_schema_id values used by this dimension.
    ///
    /// Enables the TS layer to prewarm only the subset of action schemas
    /// actually referenced, avoiding full-schema eager loading.
    #[napi]
    pub fn unique_action_schema_ids(&self) -> Vec<u32> {
        self.idx.unique_action_schema_ids()
    }

    /// Flat binary batch query — returns a raw Buffer to avoid napi object
    /// serialization overhead for `DecodedCellResult` objects.
    ///
    /// Buffer layout (all little-endian):
    ///   HEADER (12 bytes):
    ///     [0..4)   magic: u32 = 0x46425146 ("FQBF")
    ///     [4..8)   requestCount: u32
    ///     [8..12)  hitCount: u32
    ///   PER-REQUEST TABLE (requestCount × 8 bytes):
    ///     [0..2)   cellCount: u16  (0 = null/miss)
    ///     [2..4)   reserved: u16 = 0
    ///     [4..8)   actionSchemaId: u32
    ///   CELL DATA (totalCellCount × 21 bytes):
    ///     [0..4)   actionId: u32
    ///     [4..12)  frequency: f64
    ///     [12]     evFlag: u8  (1 = valid, 0 = NaN/null)
    ///     [13..21) handEv: f64  (valid when evFlag=1)
    ///
    /// Total size = 12 + requestCount × 8 + totalCellCount × 21.
    #[napi]
    pub fn query_batch_flat(
        &self,
        requests: Vec<BatchQueryRequest>,
        verify_checksum: Option<bool>,
    ) -> napi::Result<Vec<u8>> {
        let verify = verify_checksum.unwrap_or(false);
        let n = requests.len();

        // First pass: collect results, count hits and total cells
        let mut metas: Vec<(u16, u32)> = Vec::with_capacity(n); // (cellCount, schemaId)
        let mut all_cells: Vec<DecodedCellResult> = Vec::new();
        let mut hit_count: u32 = 0;

        for req in &requests {
            match self.query_inner(req.concrete_line_id, req.hand_id as u8, verify)? {
                Some(result) => {
                    let cc = result.cells.len() as u16;
                    metas.push((cc, result.action_schema_id));
                    all_cells.extend(result.cells);
                    hit_count += 1;
                }
                None => {
                    metas.push((0, 0));
                }
            }
        }

        let total_cells = all_cells.len() as u32;
        let buf_size: usize = 12 + n * 8 + total_cells as usize * 21;
        let mut buf: Vec<u8> = vec![0u8; buf_size];

        // Write header
        const FLAT_MAGIC: u32 = 0x46425146; // "FQBF"
        buf[0..4].copy_from_slice(&FLAT_MAGIC.to_le_bytes());
        buf[4..8].copy_from_slice(&(n as u32).to_le_bytes());
        buf[8..12].copy_from_slice(&hit_count.to_le_bytes());

        // Write per-request table
        let mut cursor: usize = 12;
        for (cell_count, schema_id) in &metas {
            buf[cursor..cursor + 2].copy_from_slice(&cell_count.to_le_bytes());
            cursor += 2;
            buf[cursor..cursor + 2].copy_from_slice(&0u16.to_le_bytes()); // reserved
            cursor += 2;
            buf[cursor..cursor + 4].copy_from_slice(&schema_id.to_le_bytes());
            cursor += 4;
        }

        // Write cell data
        for cell in &all_cells {
            buf[cursor..cursor + 4].copy_from_slice(&cell.action_id.to_le_bytes());
            cursor += 4;
            buf[cursor..cursor + 8].copy_from_slice(&cell.frequency.to_le_bytes());
            cursor += 8;
            let (ev_flag, ev_bytes) = match cell.hand_ev {
                Some(v) => (1u8, v.to_le_bytes()),
                None => (0u8, 0.0_f64.to_le_bytes()),
            };
            buf[cursor] = ev_flag;
            cursor += 1;
            buf[cursor..cursor + 8].copy_from_slice(&ev_bytes);
            cursor += 8;
        }

        Ok(buf)
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
        verify_checksum: Option<bool>,
    ) -> napi::Result<Vec<Option<u32>>> {
        let verify = verify_checksum.unwrap_or(false);
        requests
            .into_iter()
            .map(|req| {
                self.query_inner(req.concrete_line_id, req.hand_id as u8, verify)
                    .map(|result| result.map(|result| result.cells.len() as u32))
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
    ) -> napi::Result<Option<PackDecodeResult>> {
        // Step 1: binary search in .idx
        let record: IdxRecord = match self.idx.find(concrete_line_id) {
            Some(record) => record,
            None => return Ok(None),
        };

        if record.hand_count == 0 {
            return Err(native_invalid_format(format!(
                "Invalid .idx record for concrete_line_id {}: hand_count must be > 0",
                concrete_line_id
            )));
        }

        // Step 2: read pack data from .bin (zero-copy slice of mmap)
        let pack = self
            .bin
            .read_pack(record.offset, record.byte_length)
            .map_err(|e| {
                native_invalid_format(format!(
                    "Invalid .bin pack range for concrete_line_id {}: {}",
                    concrete_line_id, e
                ))
            })?;

        let action_count = action_count_from_pack(record.hand_count, record.byte_length);
        let expected_len = pack_byte_length(record.hand_count, action_count);
        if expected_len != record.byte_length {
            return Err(native_invalid_format(format!(
                "Invalid pack length for concrete_line_id {}: byte_length {} is incompatible with hand_count {}",
                concrete_line_id, record.byte_length, record.hand_count
            )));
        }
        if action_count > 32 {
            return Err(native_invalid_format(format!(
                "Invalid pack action count for concrete_line_id {}: {}, expected <= 32",
                concrete_line_id, action_count
            )));
        }

        // Step 3: optional CRC32C checksum verification
        if verify_checksum {
            assert_crc32c(pack, record.checksum).map_err(|reason| {
                native_checksum_mismatch(format!(
                    "{}; concrete_line_id {}, expected_checksum {}",
                    reason, concrete_line_id, record.checksum
                ))
            })?;
        }

        // Step 4: compute action_count from pack dimensions

        // Step 5: decode cells for the target hand_id
        let cells = decode_pack_for_hand(pack, record.hand_count, action_count, hand_id);

        if cells.is_empty() {
            return Ok(None);
        }

        Ok(Some(PackDecodeResult {
            action_schema_id: record.action_schema_id,
            cells,
        }))
    }
}

fn native_open_error(kind: &str, path: &str, error: io::Error) -> napi::Error {
    let message = error.to_string();
    let code = match error.kind() {
        io::ErrorKind::NotFound => "PFS_BIN_FILE_NOT_FOUND",
        io::ErrorKind::InvalidData
            if message.contains("Unsupported") && message.contains("version") =>
        {
            "PFS_UNSUPPORTED_DATA_VERSION"
        }
        io::ErrorKind::InvalidData => "PFS_INVALID_FORMAT",
        _ => "PFS_IO_ERROR",
    };

    napi::Error::from_reason(format!(
        "{}: Failed to open {} file '{}': {}",
        code, kind, path, message
    ))
}

fn native_invalid_format(message: String) -> napi::Error {
    napi::Error::from_reason(format!("PFS_INVALID_FORMAT: {}", message))
}

fn native_checksum_mismatch(message: String) -> napi::Error {
    napi::Error::from_reason(format!("PFS_CHECKSUM_MISMATCH: {}", message))
}
