import {
  Operation,
  reduceOperations,
  createOperation,
  compareOperations,
  deepEquals
} from "../src/lib/syncEngine";
import { OrderRecord } from "../src/schema";

let passed = 0;
let total = 0;

function assert(condition: boolean, testName: string, details?: string) {
  total++;
  if (condition) {
    passed++;
    console.log(`✅ [PASS] ${testName}`);
  } else {
    console.error(`❌ [FAIL] ${testName}${details ? ` -> ${details}` : ""}`);
  }
}

console.log("=================================================");
console.log("OBJECTIVE 3: OFFLINE SYNC & CONFLICT RESOLUTION TESTS");
console.log("=================================================\n");

const baseOrder: OrderRecord = {
  customer: "Rohan",
  items: [{ description: "cotton shirt", quantity: 10, attributes: { size: "40" } }],
  due_date: "2026-08-25",
  amount: 500,
  references_prior_order: false,
  confidence: 1.0,
  needs_clarification: false
};

// ----------------------------------------------------------------------------------
// TEST 1: Two devices modify DIFFERENT fields of the same order
// ----------------------------------------------------------------------------------
{
  const orderId = "ORD-TEST-1";
  const opCreate: Operation = createOperation("phone-A", orderId, "CREATE_ORDER", {
    newValue: baseOrder,
    timestamp: 1000
  });

  // Phone edits amount
  const opPhone: Operation = createOperation("phone-A", orderId, "UPDATE_FIELD", {
    field: "amount",
    oldValue: 500,
    newValue: 750,
    timestamp: 2000
  });

  // Tablet edits due_date
  const opTablet: Operation = createOperation("tablet-B", orderId, "UPDATE_FIELD", {
    field: "due_date",
    oldValue: "2026-08-25",
    newValue: "2026-09-01",
    timestamp: 2000
  });

  const { orders, conflicts } = reduceOperations([opCreate, opPhone, opTablet]);
  const order = orders.get(orderId);

  assert(
    order !== undefined && order.amount === 750 && order.due_date === "2026-09-01",
    "TEST 1: Two devices modify different fields -> Automatic merge",
    `Expected amount=750, due_date="2026-09-01", got amount=${order?.amount}, due_date=${order?.due_date}`
  );
  assert(
    conflicts.size === 0,
    "TEST 1: No conflicts generated for different field edits"
  );
}

// ----------------------------------------------------------------------------------
// TEST 2: Two devices modify same field to SAME value
// ----------------------------------------------------------------------------------
{
  const orderId = "ORD-TEST-2";
  const opCreate: Operation = createOperation("phone-A", orderId, "CREATE_ORDER", {
    newValue: baseOrder,
    timestamp: 1000
  });

  // Phone sets customer to "Rohan Sharma"
  const opPhone: Operation = createOperation("phone-A", orderId, "UPDATE_FIELD", {
    field: "customer",
    oldValue: "Rohan",
    newValue: "Rohan Sharma",
    timestamp: 2000
  });

  // Tablet also sets customer to "Rohan Sharma"
  const opTablet: Operation = createOperation("tablet-B", orderId, "UPDATE_FIELD", {
    field: "customer",
    oldValue: "Rohan",
    newValue: "Rohan Sharma",
    timestamp: 2050
  });

  const { orders, conflicts } = reduceOperations([opCreate, opPhone, opTablet]);
  const order = orders.get(orderId);

  assert(
    order !== undefined && order.customer === "Rohan Sharma",
    "TEST 2: Two devices modify same field to same value -> Converge to value"
  );
  assert(
    conflicts.size === 0,
    "TEST 2: Automatic convergence with no conflict record generated"
  );
}

// ----------------------------------------------------------------------------------
// TEST 3: Two devices modify same field to DIFFERENT values
// ----------------------------------------------------------------------------------
{
  const orderId = "ORD-TEST-3";
  const opCreate: Operation = createOperation("phone-A", orderId, "CREATE_ORDER", {
    newValue: baseOrder,
    timestamp: 1000
  });

  // Phone edits amount to 600
  const opPhone: Operation = createOperation("phone-A", orderId, "UPDATE_FIELD", {
    field: "amount",
    oldValue: 500,
    newValue: 600,
    timestamp: 2000
  });

  // Tablet edits amount to 800
  const opTablet: Operation = createOperation("tablet-B", orderId, "UPDATE_FIELD", {
    field: "amount",
    oldValue: 500,
    newValue: 800,
    timestamp: 2000
  });

  const { orders, conflicts } = reduceOperations([opCreate, opPhone, opTablet]);
  const conflict = conflicts.get(`conflict:${orderId}:amount`);

  assert(
    conflict !== undefined,
    "TEST 3: Conflicting concurrent values -> Explicit conflict record created"
  );
  assert(
    conflict?.conflictingOperations.length === 2 &&
    conflict?.conflictingOperations.some(o => o.value === 600) &&
    conflict?.conflictingOperations.some(o => o.value === 800),
    "TEST 3: Both proposed values (600 and 800) are preserved without silent loss"
  );
  assert(
    orders.get(orderId)?.parsed_order.needs_clarification === true,
    "TEST 3: Order marked needs_clarification = true while conflict is pending"
  );
}

// ----------------------------------------------------------------------------------
// TEST 4: Reconnection Order Independence (CRITICAL)
// ----------------------------------------------------------------------------------
{
  const orderId = "ORD-TEST-4";
  const opCreate: Operation = createOperation("phone-A", orderId, "CREATE_ORDER", {
    newValue: baseOrder,
    timestamp: 1000
  });

  const opPhone: Operation = createOperation("phone-A", orderId, "UPDATE_FIELD", {
    field: "amount",
    newValue: 15,
    timestamp: 2000
  });

  const opTablet: Operation = createOperation("tablet-B", orderId, "UPDATE_FIELD", {
    field: "amount",
    newValue: 20,
    timestamp: 2000
  });

  // Simulation 1: Phone reconnects first (receives Create -> Phone -> Tablet)
  const sim1 = reduceOperations([opCreate, opPhone, opTablet]);

  // Simulation 2: Tablet reconnects first (receives Create -> Tablet -> Phone)
  const sim2 = reduceOperations([opCreate, opTablet, opPhone]);

  // Simulation 3: Out of order (Tablet -> Phone -> Create)
  const sim3 = reduceOperations([opTablet, opPhone, opCreate]);

  const order1 = sim1.orders.get(orderId);
  const order2 = sim2.orders.get(orderId);
  const order3 = sim3.orders.get(orderId);

  const conflict1 = sim1.conflicts.get(`conflict:${orderId}:amount`);
  const conflict2 = sim2.conflicts.get(`conflict:${orderId}:amount`);
  const conflict3 = sim3.conflicts.get(`conflict:${orderId}:amount`);

  assert(
    deepEquals(order1, order2) && deepEquals(order2, order3),
    "TEST 4: Final order state is 100% identical regardless of reconnection order"
  );
  assert(
    deepEquals(conflict1, conflict2) && deepEquals(conflict2, conflict3),
    "TEST 4: Conflict record is 100% identical across all arrival permutations"
  );
}

// ----------------------------------------------------------------------------------
// TEST 5: Duplicate operation received twice (Idempotency)
// ----------------------------------------------------------------------------------
{
  const orderId = "ORD-TEST-5";
  const opCreate: Operation = createOperation("phone-A", orderId, "CREATE_ORDER", {
    newValue: baseOrder,
    timestamp: 1000
  });

  const opUpdate: Operation = createOperation("phone-A", orderId, "UPDATE_FIELD", {
    field: "customer",
    newValue: "Vikram Malhotra",
    timestamp: 2000
  });

  // Feed duplicate of opUpdate
  const { orders, appliedOpIds } = reduceOperations([opCreate, opUpdate, opUpdate, opUpdate]);
  const order = orders.get(orderId);

  assert(
    order !== undefined && order.customer === "Vikram Malhotra",
    "TEST 5: Idempotent processing applies duplicate operations cleanly"
  );
  assert(
    appliedOpIds.size === 2,
    "TEST 5: Exact 2 distinct operations registered in appliedOpIds"
  );
}

// ----------------------------------------------------------------------------------
// TEST 6: Delete vs Update Conflict & Tombstone Safety
// ----------------------------------------------------------------------------------
{
  const orderId = "ORD-TEST-6";
  const opCreate: Operation = createOperation("phone-A", orderId, "CREATE_ORDER", {
    newValue: baseOrder,
    timestamp: 1000
  });

  // Phone deletes the order
  const opDelete: Operation = createOperation("phone-A", orderId, "DELETE_ORDER", {
    timestamp: 2000
  });

  // Tablet concurrently updates the quantity
  const opUpdate: Operation = createOperation("tablet-B", orderId, "UPDATE_FIELD", {
    field: "amount",
    newValue: 999,
    timestamp: 2000
  });

  const { orders, conflicts } = reduceOperations([opCreate, opDelete, opUpdate]);
  const deleteConflict = conflicts.get(`conflict:${orderId}:deletion`);
  const order = orders.get(orderId);

  assert(
    deleteConflict !== undefined && deleteConflict.isDeleteConflict === true,
    "TEST 6: Delete vs update surfaces an explicit deletion conflict"
  );
  assert(
    order !== undefined && order.is_deleted === false,
    "TEST 6: Order is not silently purged; preserved pending user conflict decision"
  );
}

// ----------------------------------------------------------------------------------
// TEST 7: Identical Timestamp on Two Devices (Deterministic Tie-Breaker)
// ----------------------------------------------------------------------------------
{
  const exactTimestamp = 1750000000000;
  const opA: Operation = {
    operationId: "op-alpha",
    deviceId: "device-01-phone",
    orderId: "ORD-TEST-7",
    timestamp: exactTimestamp,
    type: "UPDATE_FIELD",
    field: "amount",
    newValue: 100
  };

  const opB: Operation = {
    operationId: "op-beta",
    deviceId: "device-02-tablet",
    orderId: "ORD-TEST-7",
    timestamp: exactTimestamp,
    type: "UPDATE_FIELD",
    field: "amount",
    newValue: 200
  };

  const cmp1 = compareOperations(opA, opB);
  const cmp2 = compareOperations(opB, opA);

  assert(
    cmp1 < 0 && cmp2 > 0,
    "TEST 7: Deterministic tie-breaker correctly compares deviceId and operationId on identical timestamps"
  );
}

// ----------------------------------------------------------------------------------
// TEST 8: Conflict Resolution Flow via RESOLVE_CONFLICT Operation
// ----------------------------------------------------------------------------------
{
  const orderId = "ORD-TEST-8";
  const opCreate: Operation = createOperation("phone-A", orderId, "CREATE_ORDER", {
    newValue: baseOrder,
    timestamp: 1000
  });

  const opPhone: Operation = createOperation("phone-A", orderId, "UPDATE_FIELD", {
    field: "amount",
    newValue: 600,
    timestamp: 2000
  });

  const opTablet: Operation = createOperation("tablet-B", orderId, "UPDATE_FIELD", {
    field: "amount",
    newValue: 800,
    timestamp: 2000
  });

  const opResolve: Operation = createOperation("phone-A", orderId, "RESOLVE_CONFLICT", {
    field: "amount",
    newValue: 800,
    conflictId: `conflict:${orderId}:amount`,
    timestamp: 3000
  });

  const { orders, conflicts } = reduceOperations([opCreate, opPhone, opTablet, opResolve]);
  const order = orders.get(orderId);
  const conflict = conflicts.get(`conflict:${orderId}:amount`);

  assert(
    conflict !== undefined && conflict.status === "resolved" && conflict.resolvedValue === 800,
    "TEST 8: RESOLVE_CONFLICT operation marks conflict as resolved with chosen value"
  );
  assert(
    order?.amount === 800 && order?.parsed_order.needs_clarification === false,
    "TEST 8: Order applies resolved value and clears needs_clarification flag"
  );
}

console.log("\n=================================================");
console.log(`TEST RESULTS: ${passed} / ${total} TESTS PASSED`);
console.log("=================================================");

if (passed === total) {
  process.exit(0);
} else {
  process.exit(1);
}
