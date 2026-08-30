import { OrderRecord, OrderItem } from "@/schema";

export type OperationType = "CREATE_ORDER" | "UPDATE_FIELD" | "DELETE_ORDER" | "RESOLVE_CONFLICT";

export interface Operation {
  operationId: string;
  deviceId: string;
  orderId: string;
  timestamp: number; // Date.now() in ms
  type: OperationType;
  field?: string;
  oldValue?: unknown;
  newValue?: unknown;
  conflictId?: string;
  synced?: boolean;
}

export interface ConflictingOp {
  operationId: string;
  deviceId: string;
  timestamp: number;
  value: unknown;
}

export interface ConflictRecord {
  conflictId: string;
  orderId: string;
  field: string;
  conflictingOperations: ConflictingOp[];
  status: "pending" | "resolved";
  resolvedValue?: unknown;
  resolvedByOpId?: string;
  isDeleteConflict?: boolean;
  createdAt: number;
}

export interface OrderState {
  id: string;
  raw_message: string;
  parsed_order: OrderRecord;
  customer: string | null;
  due_date: string | null;
  amount: number | null;
  is_completed: boolean;
  payment_status: "pending" | "paid";
  is_deleted: boolean;
  created_at: number;
  updated_at: number;
  sync_status?: "synced" | "pending_insert" | "pending_update" | "pending_delete";
}

/**
 * Deep equality check for primitives, arrays, and objects
 */
export function deepEquals(a: any, b: any): boolean {
  if (a === b) return true;
  if (a === null || b === null || a === undefined || b === undefined) return a === b;
  if (typeof a !== typeof b) return false;
  if (typeof a !== "object") return a === b;

  if (Array.isArray(a) !== Array.isArray(b)) return false;

  if (Array.isArray(a)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!deepEquals(a[i], b[i])) return false;
    }
    return true;
  }

  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  if (keysA.length !== keysB.length) return false;

  for (const k of keysA) {
    if (!Object.prototype.hasOwnProperty.call(b, k)) return false;
    if (!deepEquals(a[k], b[k])) return false;
  }
  return true;
}

/**
 * Deterministic operation comparator:
 * 1. Timestamp (earlier timestamp first)
 * 2. Device ID lexicographical comparison
 * 3. Operation ID lexicographical comparison
 *
 * This guarantees identical operation sequencing across all nodes regardless of delivery order.
 */
export function compareOperations(a: Operation, b: Operation): number {
  if (a.timestamp !== b.timestamp) {
    return a.timestamp - b.timestamp;
  }
  const devCmp = a.deviceId.localeCompare(b.deviceId);
  if (devCmp !== 0) {
    return devCmp;
  }
  return a.operationId.localeCompare(b.operationId);
}

/**
 * Sorts an array of operations deterministically
 */
export function sortOperations(ops: Operation[]): Operation[] {
  return [...ops].sort(compareOperations);
}

/**
 * Pure reducer: Applies a list of operations to produce a deterministic set of OrderStates and Conflicts.
 *
 * Core guarantees:
 * 1. Reconnection order independence: Sorting ops deterministically ensures identical reduction.
 * 2. Idempotency: Duplicate operationIds are filtered out.
 * 3. Non-conflicting merge: Edits to different fields merge automatically.
 * 4. Identical values converge: Concurrent edits with the same value produce no conflict.
 * 5. Explicit conflicts: Concurrent differing values generate a persistent ConflictRecord preserving all proposals.
 * 6. Deletion safety: Delete vs update generates an explicit conflict instead of silent resurrection or loss.
 */
export function reduceOperations(
  operations: Operation[],
  existingOrders: Map<string, OrderState> = new Map()
): {
  orders: Map<string, OrderState>;
  conflicts: Map<string, ConflictRecord>;
  appliedOpIds: Set<string>;
} {
  const sorted = sortOperations(operations);
  const orders = new Map<string, OrderState>();
  const conflicts = new Map<string, ConflictRecord>();
  const appliedOpIds = new Set<string>();

  // Clone existing orders
  for (const [id, order] of existingOrders.entries()) {
    orders.set(id, JSON.parse(JSON.stringify(order)));
  }

  // Group operations by orderId
  const opsByOrder = new Map<string, Operation[]>();
  for (const op of sorted) {
    if (appliedOpIds.has(op.operationId)) {
      continue; // Idempotency check: duplicate operationId
    }
    appliedOpIds.add(op.operationId);

    if (!opsByOrder.has(op.orderId)) {
      opsByOrder.set(op.orderId, []);
    }
    opsByOrder.get(op.orderId)!.push(op);
  }

  // Process operations per order
  for (const [orderId, ops] of opsByOrder.entries()) {
    let order = orders.get(orderId) || null;

    // Track field history for conflict detection: field -> list of operations modifying it
    const fieldHistory = new Map<string, Operation[]>();
    let deleteOp: Operation | null = null;
    const resolvedConflicts = new Map<string, any>();

    for (const op of ops) {
      if (op.type === "RESOLVE_CONFLICT") {
        if (op.conflictId) {
          resolvedConflicts.set(op.conflictId, op.newValue);
        }
        if (op.field) {
          resolvedConflicts.set(`${orderId}:${op.field}`, op.newValue);
        }
      }
    }

    for (const op of ops) {
      switch (op.type) {
        case "CREATE_ORDER": {
          const parsed = (op.newValue as OrderRecord) || {
            customer: null,
            items: [],
            due_date: null,
            amount: null,
            references_prior_order: false,
            confidence: 1.0,
            needs_clarification: false
          };

          order = {
            id: orderId,
            raw_message: typeof op.oldValue === "string" ? op.oldValue : "Order created via operation log",
            parsed_order: parsed,
            customer: parsed.customer,
            due_date: parsed.due_date,
            amount: parsed.amount,
            is_completed: false,
            payment_status: "pending",
            is_deleted: false,
            created_at: op.timestamp,
            updated_at: op.timestamp,
            sync_status: "synced"
          };
          orders.set(orderId, order);
          break;
        }

        case "UPDATE_FIELD": {
          if (!order) {
            // Lazy create placeholder order if update arrived before create
            order = {
              id: orderId,
              raw_message: "Order restored from update log",
              parsed_order: {
                customer: null,
                items: [],
                due_date: null,
                amount: null,
                references_prior_order: false,
                confidence: 1.0,
                needs_clarification: false
              },
              customer: null,
              due_date: null,
              amount: null,
              is_completed: false,
              payment_status: "pending",
              is_deleted: false,
              created_at: op.timestamp,
              updated_at: op.timestamp,
              sync_status: "synced"
            };
            orders.set(orderId, order);
          }

          const field = op.field || "unknown";
          if (!fieldHistory.has(field)) {
            fieldHistory.set(field, []);
          }
          fieldHistory.get(field)!.push(op);

          // Check if this field has a resolution operation
          const conflictKey = `${orderId}:${field}`;
          if (resolvedConflicts.has(conflictKey)) {
            const resolvedVal = resolvedConflicts.get(conflictKey);
            applyFieldUpdate(order, field, resolvedVal, op.timestamp);
          } else {
            // Optimistically apply the deterministically ordered update
            applyFieldUpdate(order, field, op.newValue, op.timestamp);
          }
          break;
        }

        case "DELETE_ORDER": {
          deleteOp = op;
          if (order) {
            order.is_deleted = true;
            order.updated_at = op.timestamp;
          }
          break;
        }

        case "RESOLVE_CONFLICT": {
          if (order && op.field) {
            applyFieldUpdate(order, op.field, op.newValue, op.timestamp);
            if (op.field === "is_deleted") {
              order.is_deleted = Boolean(op.newValue);
            }
          }
          break;
        }
      }
    }

    // Post-reduction Conflict Analysis for this order
    // 1. Check for concurrent conflicting field updates
    for (const [field, fieldOps] of fieldHistory.entries()) {
      if (fieldOps.length > 1) {
        // Group by distinct devices
        const deviceOpsMap = new Map<string, Operation>();
        for (const op of fieldOps) {
          deviceOpsMap.set(op.deviceId, op);
        }

        if (deviceOpsMap.size > 1) {
          const deviceOps = Array.from(deviceOpsMap.values());
          // Compare values across distinct devices
          const distinctValues: unknown[] = [];
          for (const dop of deviceOps) {
            if (!distinctValues.some(v => deepEquals(v, dop.newValue))) {
              distinctValues.push(dop.newValue);
            }
          }

          if (distinctValues.length > 1) {
            // Genuinely conflicting values from different devices!
            const conflictId = `conflict:${orderId}:${field}`;
            const isResolved = resolvedConflicts.has(conflictId) || resolvedConflicts.has(`${orderId}:${field}`);

            const conflictRecord: ConflictRecord = {
              conflictId,
              orderId,
              field,
              conflictingOperations: deviceOps.map(dop => ({
                operationId: dop.operationId,
                deviceId: dop.deviceId,
                timestamp: dop.timestamp,
                value: dop.newValue
              })),
              status: isResolved ? "resolved" : "pending",
              resolvedValue: isResolved ? (resolvedConflicts.get(conflictId) ?? resolvedConflicts.get(`${orderId}:${field}`)) : undefined,
              createdAt: Math.min(...deviceOps.map(d => d.timestamp))
            };

            conflicts.set(conflictId, conflictRecord);

            if (!isResolved && order) {
              order.parsed_order.needs_clarification = true;
            }
          }
        }
      }
    }

    // 2. Check for Delete vs Update conflicts
    if (deleteOp && order) {
      const concurrentUpdates = ops.filter(
        o => o.type === "UPDATE_FIELD" && o.deviceId !== deleteOp!.deviceId
      );

      if (concurrentUpdates.length > 0) {
        const deleteConflictId = `conflict:${orderId}:deletion`;
        const isResolved = resolvedConflicts.has(deleteConflictId);

        const conflictRecord: ConflictRecord = {
          conflictId: deleteConflictId,
          orderId,
          field: "deletion",
          conflictingOperations: [
            {
              operationId: deleteOp.operationId,
              deviceId: deleteOp.deviceId,
              timestamp: deleteOp.timestamp,
              value: "DELETE"
            },
            ...concurrentUpdates.map(u => ({
              operationId: u.operationId,
              deviceId: u.deviceId,
              timestamp: u.timestamp,
              value: u.newValue
            }))
          ],
          status: isResolved ? "resolved" : "pending",
          resolvedValue: isResolved ? resolvedConflicts.get(deleteConflictId) : undefined,
          isDeleteConflict: true,
          createdAt: deleteOp.timestamp
        };

        conflicts.set(deleteConflictId, conflictRecord);

        if (!isResolved) {
          order.is_deleted = false; // Do not silently purge; surface delete conflict
        }
      }
    }

    // 3. Finalize order needs_clarification flag based on active pending conflicts
    if (order) {
      const pendingConflictsForOrder = Array.from(conflicts.values()).filter(
        c => c.orderId === orderId && c.status === "pending"
      );
      if (pendingConflictsForOrder.length > 0) {
        order.parsed_order.needs_clarification = true;
      } else {
        // If all conflicts are resolved, clear conflict-induced needs_clarification
        order.parsed_order.needs_clarification = false;
      }
    }
  }

  return { orders, conflicts, appliedOpIds };
}

function applyFieldUpdate(order: OrderState, field: string, value: any, timestamp: number): void {
  order.updated_at = Math.max(order.updated_at, timestamp);

  switch (field) {
    case "customer":
      order.customer = value;
      order.parsed_order.customer = value;
      break;
    case "due_date":
      order.due_date = value;
      order.parsed_order.due_date = value;
      break;
    case "amount":
      order.amount = value !== null && !isNaN(Number(value)) ? Number(value) : null;
      order.parsed_order.amount = order.amount;
      break;
    case "items":
      if (Array.isArray(value)) {
        order.parsed_order.items = value;
      }
      break;
    case "is_completed":
      order.is_completed = Boolean(value);
      break;
    case "payment_status":
      order.payment_status = value === "paid" ? "paid" : "pending";
      break;
    case "needs_clarification":
      order.parsed_order.needs_clarification = Boolean(value);
      break;
    default:
      if (field in order.parsed_order) {
        (order.parsed_order as any)[field] = value;
      }
      break;
  }
}

/**
 * Creates an Operation object for a local mutation
 */
export function createOperation(
  deviceId: string,
  orderId: string,
  type: OperationType,
  payload: {
    field?: string;
    oldValue?: unknown;
    newValue?: unknown;
    conflictId?: string;
    timestamp?: number;
  } = {}
): Operation {
  const id = typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : `op_${Math.random().toString(36).substring(2, 11)}_${Date.now()}`;
  return {
    operationId: id,
    deviceId,
    orderId,
    timestamp: payload.timestamp ?? Date.now(),
    type,
    field: payload.field,
    oldValue: payload.oldValue,
    newValue: payload.newValue,
    conflictId: payload.conflictId,
    synced: false
  };
}

/**
 * Retrieves the persistent device ID from localStorage (or creates one)
 */
export function getDeviceId(): string {
  if (typeof window === "undefined") return "server_node";
  let id = localStorage.getItem("deviceId") || localStorage.getItem("hlc_node_id");
  if (!id) {
    const suffix = Math.random().toString(36).substring(2, 10);
    id = `device_${suffix}`;
    localStorage.setItem("deviceId", id);
    localStorage.setItem("hlc_node_id", id);
  }
  return id;
}
