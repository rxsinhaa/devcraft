import { NextResponse } from "next/server";
import {
  Operation,
  reduceOperations,
  sortOperations
} from "@/lib/syncEngine";

// In-memory server operation log (survives requests during server lifecycle)
const globalServerOperations: Map<string, Operation> = new Map();

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const incomingOps: Operation[] = Array.isArray(body.operations) ? body.operations : [];
    const clientDeviceId: string = body.deviceId || "unknown_client";
    const sinceTimestamp: number = typeof body.sinceTimestamp === "number" ? body.sinceTimestamp : 0;

    const acknowledgedOpIds: string[] = [];

    // 1. Ingest incoming operations idempotently
    for (const op of incomingOps) {
      if (!op || !op.operationId || !op.orderId || !op.type) {
        continue;
      }
      if (!globalServerOperations.has(op.operationId)) {
        globalServerOperations.set(op.operationId, {
          ...op,
          synced: true
        });
      }
      acknowledgedOpIds.push(op.operationId);
    }

    // 2. Reduce all server operations deterministically
    const allOps = Array.from(globalServerOperations.values());
    const reduction = reduceOperations(allOps);

    // 3. Return operations for peer convergence
    const sortedAllOps = sortOperations(allOps);
    const peerOps = sortedAllOps.filter(
      op => op.timestamp >= sinceTimestamp && (op.deviceId !== clientDeviceId || !acknowledgedOpIds.includes(op.operationId))
    );

    const ordersList = Array.from(reduction.orders.values());
    const conflictsList = Array.from(reduction.conflicts.values());

    return NextResponse.json({
      success: true,
      acknowledgedOpIds,
      serverOperations: peerOps,
      orders: ordersList,
      conflicts: conflictsList,
      totalServerOps: globalServerOperations.size
    });
  } catch (error: any) {
    console.error("Sync API Error:", error);
    return NextResponse.json(
      { error: error.message || "Failed to process synchronization" },
      { status: 500 }
    );
  }
}

export async function GET() {
  const allOps = Array.from(globalServerOperations.values());
  const reduction = reduceOperations(allOps);

  return NextResponse.json({
    totalOperations: allOps.length,
    orders: Array.from(reduction.orders.values()),
    conflicts: Array.from(reduction.conflicts.values())
  });
}
