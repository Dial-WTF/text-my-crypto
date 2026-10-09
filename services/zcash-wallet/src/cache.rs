//! An in-memory compact block cache. `sync::run` downloads a batch, scans it, then deletes it,
//! so the cache only ever holds one batch.

use std::{
    collections::BTreeMap,
    convert::Infallible,
    sync::{Arc, Mutex},
};

use async_trait::async_trait;
use zcash_client_backend::{
    data_api::{
        chain::{BlockCache, BlockSource, error::Error as ChainError},
        scanning::ScanRange,
    },
    proto::compact_formats::CompactBlock,
};
use zcash_protocol::consensus::BlockHeight;

#[derive(Clone, Default)]
pub struct MemCache(Arc<Mutex<BTreeMap<u32, CompactBlock>>>);

fn height(block: &CompactBlock) -> u32 {
    u32::try_from(block.height).unwrap_or(u32::MAX)
}

impl MemCache {
    fn blocks(&self) -> std::sync::MutexGuard<'_, BTreeMap<u32, CompactBlock>> {
        self.0.lock().unwrap_or_else(|e| e.into_inner())
    }
}

impl BlockSource for MemCache {
    type Error = Infallible;

    fn with_blocks<F, WalletErrT>(
        &self,
        from_height: Option<BlockHeight>,
        limit: Option<usize>,
        mut with_block: F,
    ) -> Result<(), ChainError<WalletErrT, Self::Error>>
    where
        F: FnMut(CompactBlock) -> Result<(), ChainError<WalletErrT, Self::Error>>,
    {
        let from = from_height.map_or(0, u32::from);
        let batch: Vec<CompactBlock> = self
            .blocks()
            .range(from..)
            .take(limit.unwrap_or(usize::MAX))
            .map(|(_, b)| b.clone())
            .collect();
        for block in batch {
            with_block(block)?;
        }
        Ok(())
    }
}

#[async_trait]
impl BlockCache for MemCache {
    fn get_tip_height(&self, range: Option<&ScanRange>) -> Result<Option<BlockHeight>, Self::Error> {
        let blocks = self.blocks();
        let tip = match range {
            Some(r) => blocks
                .keys()
                .rev()
                .find(|h| r.block_range().contains(&BlockHeight::from_u32(**h))),
            None => blocks.keys().next_back(),
        };
        Ok(tip.map(|h| BlockHeight::from_u32(*h)))
    }

    async fn read(&self, range: &ScanRange) -> Result<Vec<CompactBlock>, Self::Error> {
        let start = u32::from(range.block_range().start);
        let end = u32::from(range.block_range().end);
        Ok(self.blocks().range(start..end).map(|(_, b)| b.clone()).collect())
    }

    async fn insert(&self, compact_blocks: Vec<CompactBlock>) -> Result<(), Self::Error> {
        let mut blocks = self.blocks();
        for b in compact_blocks {
            blocks.insert(height(&b), b);
        }
        Ok(())
    }

    async fn delete(&self, range: ScanRange) -> Result<(), Self::Error> {
        let start = u32::from(range.block_range().start);
        let end = u32::from(range.block_range().end);
        self.blocks().retain(|h, _| *h < start || *h >= end);
        Ok(())
    }
}
