// Facade of the slot store: the pure model (store-model.ts) and the synchronous disk half (store-sync.ts) under the
// names every importer already uses. New coordinator code goes through slot-store.ts (memory plus executor) instead.
export {
  SLOT_ID_RE, currentBinding, parseEventLine, parseEvents,
  type EventsRead, type InferredBinding, type SlotsScan,
} from './store-model.ts'
export {
  appendEvent, clearRun, createSlot, listSlots, newSlotId, readEvents, readEventsFile, readEventsFrom,
  readRun, readSlot, removeSlot, scanSlots, scanSlotsAsync, writeRun, writeSlotMeta,
} from './store-sync.ts'
