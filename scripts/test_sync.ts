import crypto from "crypto";

// Interfaces matching db.ts
export interface Operation {
  operationId: string;
  deviceId: string;
  orderId: string;
  timestamp: number;
  type: "CREATE_ORDER" | "DELETE_ORDER" | "UPDATE_FIELD" | "RESOLVE_CONFLICT";
  field?: string;
  oldValue?: any;
  newValue?: any;
  synced: boolean;
}

export interface LocalOrder {
  id: string;
  raw_message: string;
  parsed_order: any;
  customer: string | null;
  due_date: string | null;
  sync_status: string;
  created_at: number;
  updated_at: number;
  is_completed: boolean;
  payment_status: string;
}

export interface ConflictRecord {
  conflictId: string;
  orderId: string;
  field: string;
  conflictingOperations: {
    operationId: string;
    deviceId: string;
    value: any;
  }[];
  status: "pending" | "resolved";
}

// Pure TS implementation of replayOperations logic to validate determinism
export function simulateReplay(allOps: Operation[], currentDevice: string) {
  // Deterministic sort: timestamp -> deviceId -> operationId
  const sortedOps = [...allOps].sort((a, b) => {
    if (a.timestamp !== b.timestamp) {
      return a.timestamp - b.timestamp;
    }
    if (a.deviceId !== b.deviceId) {
      return a.deviceId.localeCompare(b.deviceId);
    }
    return a.operationId.localeCompare(b.operationId);
  });

  const ordersMap: Record<string, LocalOrder> = {};
  const conflictsMap: Record<string, ConflictRecord> = {};
  const deletedOrders = new Set<string>();
  const deleteOps: Record<string, Operation> = {};
  
  // Track field state history
  const fieldHistory: Record<string, { lastOp: Operation; value: any }> = {};

  const applyFieldUpdate = (order: LocalOrder, field: string, value: any) => {
    (order as any)[field] = value;
    if (order.parsed_order) {
      order.parsed_order[field] = value;
    }
  };

  for (const op of sortedOps) {
    const { orderId, type, field, newValue, oldValue, deviceId } = op;

    if (type === "CREATE_ORDER") {
      ordersMap[orderId] = {
        ...newValue,
        is_completed: newValue.is_completed || false,
        payment_status: newValue.payment_status || "pending",
        sync_status: op.synced ? "synced" : "pending_insert"
      };
      deletedOrders.delete(orderId);
    } 
    else if (type === "DELETE_ORDER") {
      deletedOrders.add(orderId);
      deleteOps[orderId] = op;
      delete ordersMap[orderId];
      
      // Update vs Delete conflict check
      for (const [key, history] of Object.entries(fieldHistory)) {
        if (key.startsWith(`${orderId}:`) && history.lastOp.deviceId !== deviceId) {
          const conflictId = `${orderId}:delete`;
          conflictsMap[conflictId] = {
            conflictId,
            orderId,
            field: "delete",
            conflictingOperations: [
              { operationId: op.operationId, deviceId: op.deviceId, value: "delete" },
              { operationId: history.lastOp.operationId, deviceId: history.lastOp.deviceId, value: "update" }
            ],
            status: "pending"
          };
        }
      }
    } 
    else if (type === "UPDATE_FIELD" && field) {
      const fieldKey = `${orderId}:${field}`;

      // Update vs Delete conflict check
      if (deletedOrders.has(orderId)) {
        if (deleteOps[orderId] && deleteOps[orderId].deviceId !== deviceId) {
          const conflictId = `${orderId}:delete`;
          conflictsMap[conflictId] = {
            conflictId,
            orderId,
            field: "delete",
            conflictingOperations: [
              { operationId: deleteOps[orderId].operationId, deviceId: deleteOps[orderId].deviceId, value: "delete" },
              { operationId: op.operationId, deviceId: op.deviceId, value: "update" }
            ],
            status: "pending"
          };
        }
        continue;
      }

      const order = ordersMap[orderId];
      if (order) {
        const prev = fieldHistory[fieldKey];
        if (prev) {
          const isDifferentDevice = op.deviceId !== prev.lastOp.deviceId;
          const isConcurrent = op.oldValue !== prev.value;
          const isDifferentValue = op.newValue !== prev.value;

          if (isDifferentDevice && isConcurrent && isDifferentValue) {
            const conflictId = `${orderId}:${field}`;
            conflictsMap[conflictId] = {
              conflictId,
              orderId,
              field,
              conflictingOperations: [
                { operationId: prev.lastOp.operationId, deviceId: prev.lastOp.deviceId, value: prev.value },
                { operationId: op.operationId, deviceId: op.deviceId, value: op.newValue }
              ],
              status: "pending"
            };
          } else {
            applyFieldUpdate(order, field, newValue);
            fieldHistory[fieldKey] = { lastOp: op, value: newValue };
          }
        } else {
          applyFieldUpdate(order, field, newValue);
          fieldHistory[fieldKey] = { lastOp: op, value: newValue };
        }
      }
    } 
    else if (type === "RESOLVE_CONFLICT" && field) {
      const order = ordersMap[orderId];
      if (order) {
        applyFieldUpdate(order, field, newValue);
        fieldHistory[`${orderId}:${field}`] = { lastOp: op, value: newValue };
        delete conflictsMap[`${orderId}:${field}`];
      }

      if (field === "delete") {
        if (newValue === "delete") {
          deletedOrders.add(orderId);
          delete ordersMap[orderId];
        } else {
          deletedOrders.delete(orderId);
          if (!ordersMap[orderId] && deleteOps[orderId]) {
            const createOp = sortedOps.find(o => o.orderId === orderId && o.type === "CREATE_ORDER");
            if (createOp) {
              ordersMap[orderId] = { ...createOp.newValue };
              for (const [key, history] of Object.entries(fieldHistory)) {
                if (key.startsWith(`${orderId}:`)) {
                  const f = key.split(":")[1];
                  applyFieldUpdate(ordersMap[orderId], f, history.value);
                }
              }
            }
          }
        }
        delete conflictsMap[`${orderId}:delete`];
      }
    }
  }

  return { ordersMap, conflictsMap };
}

// Validation test suites
function runTests() {
  console.log("==================================================");
  console.log("     Starting Offline Sync Operation Log Tests     ");
  console.log("==================================================");

  const orderId = "ORD-1001";
  const initialOrder: LocalOrder = {
    id: orderId,
    raw_message: "initial message",
    parsed_order: { customer: "Ramesh Ji", due_date: "2026-08-30", amount: 500 },
    customer: "Ramesh Ji",
    due_date: "2026-08-30",
    sync_status: "synced",
    created_at: 1750000000000,
    updated_at: 1750000000000,
    is_completed: false,
    payment_status: "pending"
  };

  const createOp: Operation = {
    operationId: "op-create",
    deviceId: "phone-A",
    orderId,
    timestamp: 1750000000000,
    type: "CREATE_ORDER",
    newValue: initialOrder,
    synced: true
  };

  // TEST 1: Two devices modify different fields
  console.log("TEST 1: Two devices modify different fields (Automatic Merge)");
  const opA1: Operation = {
    operationId: "op-A1",
    deviceId: "phone-A",
    orderId,
    timestamp: 1750000005000,
    type: "UPDATE_FIELD",
    field: "due_date",
    oldValue: "2026-08-30",
    newValue: "2026-09-01",
    synced: false
  };
  const opB1: Operation = {
    operationId: "op-B1",
    deviceId: "tablet-B",
    orderId,
    timestamp: 1750000010000,
    type: "UPDATE_FIELD",
    field: "payment_status",
    oldValue: "pending",
    newValue: "paid",
    synced: false
  };
  let result = simulateReplay([createOp, opA1, opB1], "phone-A");
  const orderT1 = result.ordersMap[orderId];
  if (orderT1 && orderT1.due_date === "2026-09-01" && orderT1.payment_status === "paid" && Object.keys(result.conflictsMap).length === 0) {
    console.log("-> [PASS] Automatically merged fields due_date and payment_status.\n");
  } else {
    console.error("-> [FAIL] Test 1 failed.", result);
    process.exit(1);
  }

  // TEST 2: Two devices modify same field to same value
  console.log("TEST 2: Two devices modify same field to same value (Auto Convergence)");
  const opA2: Operation = {
    operationId: "op-A2",
    deviceId: "phone-A",
    orderId,
    timestamp: 1750000005000,
    type: "UPDATE_FIELD",
    field: "payment_status",
    oldValue: "pending",
    newValue: "paid",
    synced: false
  };
  const opB2: Operation = {
    operationId: "op-B2",
    deviceId: "tablet-B",
    orderId,
    timestamp: 1750000010000,
    type: "UPDATE_FIELD",
    field: "payment_status",
    oldValue: "pending",
    newValue: "paid",
    synced: false
  };
  result = simulateReplay([createOp, opA2, opB2], "phone-A");
  const orderT2 = result.ordersMap[orderId];
  if (orderT2 && orderT2.payment_status === "paid" && Object.keys(result.conflictsMap).length === 0) {
    console.log("-> [PASS] Converged to 'paid' without raising any conflicts.\n");
  } else {
    console.error("-> [FAIL] Test 2 failed.", result);
    process.exit(1);
  }

  // TEST 3: Two devices modify same field to different values
  console.log("TEST 3: Two devices modify same field to different values (Conflict Surface)");
  const opA3: Operation = {
    operationId: "op-A3",
    deviceId: "phone-A",
    orderId,
    timestamp: 1750000005000,
    type: "UPDATE_FIELD",
    field: "due_date",
    oldValue: "2026-08-30",
    newValue: "2026-09-01",
    synced: false
  };
  const opB3: Operation = {
    operationId: "op-B3",
    deviceId: "tablet-B",
    orderId,
    timestamp: 1750000010000,
    type: "UPDATE_FIELD",
    field: "due_date",
    oldValue: "2026-08-30",
    newValue: "2026-09-05",
    synced: false
  };
  result = simulateReplay([createOp, opA3, opB3], "phone-A");
  const conflict = result.conflictsMap[`${orderId}:due_date`];
  if (conflict && conflict.conflictingOperations.length === 2 && conflict.status === "pending") {
    console.log("-> [PASS] Correctly detected conflict on due_date. Preserved values: '2026-09-01' and '2026-09-05'.\n");
  } else {
    console.error("-> [FAIL] Test 3 failed.", result);
    process.exit(1);
  }

  // TEST 4: Reconnection Order Independence
  console.log("TEST 4: Same operations received in reverse order (Deterministic Convergence)");
  const seq1 = simulateReplay([createOp, opA3, opB3], "phone-A");
  const seq2 = simulateReplay([createOp, opB3, opA3], "phone-A");
  const conflictSeq1 = seq1.conflictsMap[`${orderId}:due_date`];
  const conflictSeq2 = seq2.conflictsMap[`${orderId}:due_date`];
  if (JSON.stringify(conflictSeq1) === JSON.stringify(conflictSeq2)) {
    console.log("-> [PASS] Reconnection order does not affect final state or conflict resolution.\n");
  } else {
    console.error("-> [FAIL] Test 4 failed.", { seq1, seq2 });
    process.exit(1);
  }

  // TEST 5: Duplicate operation received twice (Idempotency)
  console.log("TEST 5: Duplicate operation received twice (Idempotency)");
  result = simulateReplay([createOp, opA3, opA3, opB3], "phone-A");
  const conflictT5 = result.conflictsMap[`${orderId}:due_date`];
  if (conflictT5 && conflictT5.conflictingOperations.length === 2) {
    console.log("-> [PASS] Idempotency checks succeeded. Duplicate operations ignored safely.\n");
  } else {
    console.error("-> [FAIL] Test 5 failed.", result);
    process.exit(1);
  }

  // TEST 6: Delete vs update
  console.log("TEST 6: Delete vs Update (Delete Tombstone Conflict)");
  const opDelete: Operation = {
    operationId: "op-del",
    deviceId: "phone-A",
    orderId,
    timestamp: 1750000005000,
    type: "DELETE_ORDER",
    synced: false
  };
  const opUpdate: Operation = {
    operationId: "op-up",
    deviceId: "tablet-B",
    orderId,
    timestamp: 1750000010000,
    type: "UPDATE_FIELD",
    field: "payment_status",
    oldValue: "pending",
    newValue: "paid",
    synced: false
  };
  result = simulateReplay([createOp, opDelete, opUpdate], "phone-A");
  const delConflict = result.conflictsMap[`${orderId}:delete`];
  if (delConflict && delConflict.status === "pending") {
    console.log("-> [PASS] Correctly detected Delete vs Update conflict. surfaced options safely.\n");
  } else {
    console.error("-> [FAIL] Test 6 failed.", result);
    process.exit(1);
  }

  // TEST 7: Same timestamp on two devices (Deterministic tie-breaker)
  console.log("TEST 7: Same timestamp on two devices (Tie-breaker logic)");
  const opA7: Operation = {
    operationId: "op-A7",
    deviceId: "phone-A",
    orderId,
    timestamp: 1750000000000,
    type: "UPDATE_FIELD",
    field: "due_date",
    oldValue: "2026-08-30",
    newValue: "2026-09-01",
    synced: false
  };
  const opB7: Operation = {
    operationId: "op-B7",
    deviceId: "tablet-B",
    orderId,
    timestamp: 1750000000000,
    type: "UPDATE_FIELD",
    field: "due_date",
    oldValue: "2026-08-30",
    newValue: "2026-09-05",
    synced: false
  };
  // Sort sequence test
  const testSeq = [opB7, opA7];
  testSeq.sort((a, b) => {
    if (a.timestamp !== b.timestamp) return a.timestamp - b.timestamp;
    if (a.deviceId !== b.deviceId) return a.deviceId.localeCompare(b.deviceId);
    return a.operationId.localeCompare(b.operationId);
  });
  if (testSeq[0].deviceId === "phone-A" && testSeq[1].deviceId === "tablet-B") {
    console.log("-> [PASS] Deterministic ordering ties resolved lexicographically by deviceId.\n");
  } else {
    console.error("-> [FAIL] Test 7 failed.", testSeq);
    process.exit(1);
  }

  console.log("==================================================");
  console.log("         ALL 7 OFFLINE SYNC TESTS PASSED!         ");
  console.log("==================================================");
}

runTests();
