import { NextRequest, NextResponse } from "next/server";

// Global server operation log persistence across hot-reloads
if (!(global as any).serverOperations) {
  (global as any).serverOperations = [];
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const { clientOperations } = body;

    if (!Array.isArray(clientOperations)) {
      return NextResponse.json({ error: "clientOperations must be an array" }, { status: 400 });
    }

    const serverOps = (global as any).serverOperations as any[];

    // 1. Idempotently merge incoming client operations
    for (const op of clientOperations) {
      const exists = serverOps.some(o => o.operationId === op.operationId);
      if (!exists) {
        serverOps.push(op);
      }
    }

    // 2. Sort server log deterministically
    serverOps.sort((a, b) => {
      if (a.timestamp !== b.timestamp) {
        return a.timestamp - b.timestamp;
      }
      if (a.deviceId !== b.deviceId) {
        return a.deviceId.localeCompare(b.deviceId);
      }
      return a.operationId.localeCompare(b.operationId);
    });

    return NextResponse.json({
      serverOperations: serverOps
    });
  } catch (err: any) {
    console.error("Sync error:", err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
