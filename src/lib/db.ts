import Dexie, { type Table } from "dexie";
import { OrderRecord } from "@/schema";
import { getGlobalHLC, compareHLC } from "./hlc";

export interface LocalOrder {
  id: string; // UUIDv4 string
  raw_message: string;
  parsed_order: OrderRecord;
  // Extracted top-level fields to enable fast IndexedDB secondary indexes
  customer: string | null;
  due_date: string | null;
  sync_status: "synced" | "pending_insert" | "pending_update" | "pending_delete";
  created_at: number; // timestamp (ms)
  updated_at: number; // timestamp (ms)
  is_completed: boolean; // order completion state
  payment_status: "pending" | "paid"; // payment status tracking
}

export interface EventLogEntry {
  id: string; // UUIDv4 string
  timestamp: string; // HLC timestamp string
  order_id: string;
  action: "CREATE" | "UPDATE" | "DELETE";
  field: string; // "all" for CREATE/DELETE, or the specific field name (e.g. "due_date") for UPDATE
  value: any; // JSON representation of the value or full parsed order
  node_id: string;
}

export interface ConflictState {
  id: string; // "order_id:field"
  order_id: string;
  field: string;
  local_value: any;
  local_timestamp: string;
  remote_value: any;
  remote_timestamp: string;
  resolved: boolean;
}

class OrderDatabase extends Dexie {
  orders!: Table<LocalOrder, string>;
  event_log!: Table<EventLogEntry, string>;
  conflict_state!: Table<ConflictState, string>;

  constructor() {
    super("OrderDatabase");
    
    // Define the DB schema, including events log and conflict state table
    this.version(1).stores({
      orders: "id, created_at, due_date, sync_status, customer",
      event_log: "id, timestamp, order_id, action, node_id",
      conflict_state: "id, order_id, resolved"
    });
  }
}

// Instantiate the database
export const db = new OrderDatabase();

/**
 * Requests the browser to flag IndexedDB storage for this origin as persistent.
 */
export async function requestPersistentStorage(): Promise<boolean> {
  if (typeof window !== "undefined" && navigator.storage && navigator.storage.persist) {
    try {
      const isPersisted = await navigator.storage.persist();
      console.log(`Persistent storage request result: ${isPersisted}`);
      return isPersisted;
    } catch (error) {
      console.error("Failed to request persistent storage:", error);
    }
  }
  return false;
}

// Request persistent storage when the database opens successfully
db.on("ready", () => {
  requestPersistentStorage();
});

/**
 * Creates a new order locally, logging a CREATE event in the append-only event log.
 */
export async function createOrder(rawMessage: string, parsed: OrderRecord): Promise<string> {
  const id = crypto.randomUUID();
  const now = Date.now();
  
  const newOrder: LocalOrder = {
    id,
    raw_message: rawMessage,
    parsed_order: parsed,
    customer: parsed.customer,
    due_date: parsed.due_date,
    sync_status: "pending_insert",
    created_at: now,
    updated_at: now,
    is_completed: false,
    payment_status: "pending"
  };

  try {
    await db.transaction("rw", [db.orders, db.event_log], async () => {
      // 1. Write the order record
      await db.orders.add(newOrder);

      // 2. Generate and append a CREATE event to the event log
      const hlcTime = getGlobalHLC().increment();
      const createEvent: EventLogEntry = {
        id: crypto.randomUUID(),
        timestamp: hlcTime,
        order_id: id,
        action: "CREATE",
        field: "all",
        value: parsed,
        node_id: getGlobalHLC().getNodeId()
      };
      await db.event_log.add(createEvent);
    });
    return id;
  } catch (error: any) {
    if (error.name === "QuotaExceededError") {
      alert("Storage quota exceeded! Please free up space on your device to save orders.");
    }
    throw error;
  }
}

/**
 * Updates an order locally, generating individual field-level UPDATE events in the event log.
 */
export async function updateOrder(id: string, updates: Partial<OrderRecord>): Promise<void> {
  const now = Date.now();

  try {
    await db.transaction("rw", [db.orders, db.event_log], async () => {
      const existing = await db.orders.get(id);
      if (!existing) throw new Error(`Order with ID ${id} not found.`);

      const updatedParsed: OrderRecord = {
        ...existing.parsed_order,
        ...updates
      };

      const newSyncStatus = existing.sync_status === "pending_insert" 
        ? "pending_insert" 
        : "pending_update";

      // 1. Update the order record
      await db.orders.update(id, {
        parsed_order: updatedParsed,
        customer: updatedParsed.customer,
        due_date: updatedParsed.due_date,
        sync_status: newSyncStatus,
        updated_at: now
      });

      // 2. Log events for each specific modified field to enable fine-grained causal sync
      const localNodeId = getGlobalHLC().getNodeId();
      for (const key of Object.keys(updates) as Array<keyof OrderRecord>) {
        const hlcTime = getGlobalHLC().increment();
        const updateEvent: EventLogEntry = {
          id: crypto.randomUUID(),
          timestamp: hlcTime,
          order_id: id,
          action: "UPDATE",
          field: key,
          value: updates[key],
          node_id: localNodeId
        };
        await db.event_log.add(updateEvent);
      }
    });
  } catch (error: any) {
    if (error.name === "QuotaExceededError") {
      alert("Storage quota exceeded! Please free up space on your device to update this order.");
    }
    throw error;
  }
}

/**
 * Deletes an order, logging a DELETE event in the append-only event log.
 */
export async function deleteOrder(id: string): Promise<void> {
  try {
    await db.transaction("rw", [db.orders, db.event_log], async () => {
      const existing = await db.orders.get(id);
      if (!existing) return;

      const localNodeId = getGlobalHLC().getNodeId();
      const hlcTime = getGlobalHLC().increment();
      
      const deleteEvent: EventLogEntry = {
        id: crypto.randomUUID(),
        timestamp: hlcTime,
        order_id: id,
        action: "DELETE",
        field: "all",
        value: null,
        node_id: localNodeId
      };
      await db.event_log.add(deleteEvent);

      if (existing.sync_status === "pending_insert") {
        // Purge immediately if it was never synced
        await db.orders.delete(id);
      } else {
        // Soft delete locally, to be resolved with remote deletions
        await db.orders.update(id, {
          sync_status: "pending_delete",
          updated_at: Date.now()
        });
      }
    });
  } catch (error: any) {
    if (error.name === "QuotaExceededError") {
      alert("Storage quota exceeded! Please free up space to perform this deletion.");
    }
    throw error;
  }
}

/**
 * Replays event log entries (potentially containing remote sync events)
 * onto the local orders state. Suspends merge and logs conflicts into conflict_state
 * if two concurrent updates on the same field differ in value.
 */
export async function replayEvents(incomingEvents: EventLogEntry[]): Promise<void> {
  const sortedEvents = [...incomingEvents].sort((a, b) => compareHLC(a.timestamp, b.timestamp));
  const localNodeId = getGlobalHLC().getNodeId();

  await db.transaction("rw", [db.orders, db.event_log, db.conflict_state], async () => {
    for (const event of sortedEvents) {
      // 1. Advance the local HLC based on incoming logical time
      getGlobalHLC().receive(event.timestamp);

      // 2. Deduplicate: if event already exists locally, skip
      const existingLog = await db.event_log.get(event.id);
      if (existingLog) continue;

      // Record the incoming event in the event log
      await db.event_log.add(event);

      const orderId = event.order_id;
      const localOrder = await db.orders.get(orderId);

      // 3. Conflict Detection
      // If the incoming event is from a REMOTE node, and we have an UNSYNCED LOCAL event
      // for the exact same order and field with a DIFFERENT value, a conflict exists.
      if (event.node_id !== localNodeId) {
        const localUnsyncedEvents = await db.event_log
          .where("order_id")
          .equals(orderId)
          .and(x => x.node_id === localNodeId && x.field === event.field)
          .toArray();

        // Check if there is an unsynced local edit that differs in value
        const conflictEvent = localUnsyncedEvents.find(
          x => JSON.stringify(x.value) !== JSON.stringify(event.value)
        );

        if (conflictEvent) {
          // Pause LWW merge for this field and save the conflict
          await db.conflict_state.put({
            id: `${orderId}:${event.field}`,
            order_id: orderId,
            field: event.field,
            local_value: conflictEvent.value,
            local_timestamp: conflictEvent.timestamp,
            remote_value: event.value,
            remote_timestamp: event.timestamp,
            resolved: false
          });

          // Mark local order as having conflicts (needs_clarification = true)
          if (localOrder) {
            await db.orders.update(orderId, {
              "parsed_order.needs_clarification": true,
              "parsed_order.confidence": 0.3
            });
          }
          console.warn(`[Sync Conflict] Paused merge on Order ${orderId}, Field: "${event.field}"`);
          continue; // Skip automatic overwrite for this field
        }
      }

      // 4. Last-Write-Wins (LWW) Causal Application
      if (event.action === "CREATE") {
        if (!localOrder) {
          const now = Date.now();
          const newOrder: LocalOrder = {
            id: orderId,
            raw_message: "Created via event synchronization.",
            parsed_order: event.value,
            customer: event.value.customer,
            due_date: event.value.due_date,
            sync_status: "synced",
            created_at: now,
            updated_at: now,
            is_completed: event.value.is_completed || false,
            payment_status: event.value.payment_status || "pending"
          };
          await db.orders.add(newOrder);
        }
      } 
      else if (event.action === "UPDATE") {
        if (localOrder) {
          const updatedParsed = {
            ...localOrder.parsed_order,
            [event.field]: event.value
          };
          
          await db.orders.update(orderId, {
            parsed_order: updatedParsed,
            customer: event.field === "customer" ? event.value : localOrder.customer,
            due_date: event.field === "due_date" ? event.value : localOrder.due_date,
            sync_status: "synced",
            updated_at: Date.now()
          });
        }
      } 
      else if (event.action === "DELETE") {
        if (localOrder) {
          await db.orders.delete(orderId);
        }
      }
    }
  });
}

/**
 * Resolves a conflict by choosing the winning value.
 * Appends a new UPDATE event to propagate the resolution and updates the local order state.
 */
export async function resolveConflict(orderId: string, field: string, resolvedValue: any): Promise<void> {
  const conflictId = `${orderId}:${field}`;
  
  await db.transaction("rw", [db.orders, db.conflict_state, db.event_log], async () => {
    const conflict = await db.conflict_state.get(conflictId);
    if (!conflict) return;

    // 1. Remove the conflict state record
    await db.conflict_state.delete(conflictId);

    // 2. Generate a resolution update event
    const hlcTime = getGlobalHLC().increment();
    const resolveEvent: EventLogEntry = {
      id: crypto.randomUUID(),
      timestamp: hlcTime,
      order_id: orderId,
      action: "UPDATE",
      field: field,
      value: resolvedValue,
      node_id: getGlobalHLC().getNodeId()
    };
    await db.event_log.add(resolveEvent);

    // 3. Update local order state
    const localOrder = await db.orders.get(orderId);
    if (localOrder) {
      const updatedParsed = {
        ...localOrder.parsed_order,
        [field]: resolvedValue
      };

      // Check if there are other unresolved conflicts for this order
      const remainingConflicts = await db.conflict_state
        .where("order_id")
        .equals(orderId)
        .toArray();

      const stillHasConflicts = remainingConflicts.length > 0;

      await db.orders.update(orderId, {
        parsed_order: updatedParsed,
        customer: field === "customer" ? resolvedValue : localOrder.customer,
        due_date: field === "due_date" ? resolvedValue : localOrder.due_date,
        "parsed_order.needs_clarification": stillHasConflicts,
        sync_status: "pending_update",
        updated_at: Date.now()
      });
    }
  });
}

/**
 * Retrieves a single order record by ID.
 */
export async function getOrder(id: string): Promise<LocalOrder | undefined> {
  return db.orders.get(id);
}

/**
 * Retrieves all active orders, excluding those flagged as pending_delete.
 * Sorted chronologically descending by creation date.
 */
export async function getActiveOrders(): Promise<LocalOrder[]> {
  return db.orders
    .where("sync_status")
    .noneOf(["pending_delete"])
    .reverse()
    .sortBy("created_at");
}

/**
 * Queries all local modifications that have not yet been synchronized.
 */
export async function getPendingChanges(): Promise<LocalOrder[]> {
  return db.orders
    .where("sync_status")
    .anyOf(["pending_insert", "pending_update", "pending_delete"])
    .toArray();
}

/**
 * Marks a batch of local orders as synchronized with the remote database.
 * If sync_status was 'pending_delete', it is physically purged.
 */
export async function markAsSynced(ids: string[]): Promise<void> {
  const now = Date.now();
  
  await db.transaction("rw", db.orders, async () => {
    for (const id of ids) {
      const existing = await db.orders.get(id);
      if (!existing) continue;

      if (existing.sync_status === "pending_delete") {
        await db.orders.delete(id);
      } else {
        await db.orders.update(id, {
          sync_status: "synced",
          updated_at: now
        });
      }
    }
  });
}

/**
 * Toggles the completion status of an order and appends an HLC event.
 */
export async function toggleOrderCompletion(id: string): Promise<void> {
  const now = Date.now();
  await db.transaction("rw", [db.orders, db.event_log], async () => {
    const existing = await db.orders.get(id);
    if (!existing) throw new Error(`Order with ID ${id} not found.`);

    const newCompleted = !existing.is_completed;
    
    // Update local order
    await db.orders.update(id, {
      is_completed: newCompleted,
      updated_at: now
    });

    // Log the event
    const hlcTime = getGlobalHLC().increment();
    const event: EventLogEntry = {
      id: crypto.randomUUID(),
      timestamp: hlcTime,
      order_id: id,
      action: "UPDATE",
      field: "is_completed" as any, // Cast to any to log local status updates
      value: newCompleted,
      node_id: getGlobalHLC().getNodeId()
    };
    await db.event_log.add(event);
  });
}

/**
 * Toggles the payment status of an order and appends an HLC event.
 */
export async function togglePaymentStatus(id: string): Promise<void> {
  const now = Date.now();
  await db.transaction("rw", [db.orders, db.event_log], async () => {
    const existing = await db.orders.get(id);
    if (!existing) throw new Error(`Order with ID ${id} not found.`);

    const newPaymentStatus = existing.payment_status === "paid" ? "pending" : "paid";
    
    // Update local order
    await db.orders.update(id, {
      payment_status: newPaymentStatus,
      updated_at: now
    });

    // Log the event
    const hlcTime = getGlobalHLC().increment();
    const event: EventLogEntry = {
      id: crypto.randomUUID(),
      timestamp: hlcTime,
      order_id: id,
      action: "UPDATE",
      field: "payment_status" as any,
      value: newPaymentStatus,
      node_id: getGlobalHLC().getNodeId()
    };
    await db.event_log.add(event);
  });
}

