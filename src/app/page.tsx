"use client";

import { useState, useMemo, useEffect } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { 
  db, 
  LocalOrder, 
  ConflictState, 
  EventLogEntry, 
  createOrder, 
  updateOrder, 
  deleteOrder, 
  resolveConflict, 
  getActiveOrders, 
  toggleOrderCompletion, 
  togglePaymentStatus,
  replayEvents
} from "@/lib/db";
import { parseMessage } from "@/lib/llmClient";
import { OrderRecord } from "@/schema";
import styles from "./page.module.css";

// Helper to get formatted local YYYY-MM-DD
function getLocalDateString(date: Date = new Date()): string {
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

export default function Dashboard() {
  const [inputText, setInputText] = useState("");
  const [selectedHistoryCustomer, setSelectedHistoryCustomer] = useState("");
  const [isProcessing, setIsProcessing] = useState(false);
  const [isConflictModalOpen, setIsConflictModalOpen] = useState(false);
  const [onlineStatus, setOnlineStatus] = useState(true);

  // Monitor network status reactively
  useEffect(() => {
    if (typeof window !== "undefined") {
      setOnlineStatus(navigator.onLine);
      const goOnline = () => setOnlineStatus(true);
      const goOffline = () => setOnlineStatus(false);
      window.addEventListener("online", goOnline);
      window.addEventListener("offline", goOffline);
      return () => {
        window.removeEventListener("online", goOnline);
        window.removeEventListener("offline", goOffline);
      };
    }
  }, []);

  // 1. Live Query active orders (live update from Dexie)
  const orders = useLiveQuery(getActiveOrders) || [];

  // 2. Live Query active conflicts
  const conflicts = useLiveQuery(() => db.conflict_state.toArray()) || [];

  // Local helper for Today's Date representation
  const todayStr = useMemo(() => getLocalDateString(), []);

  // A. Temporal Triage calculation
  const { todayOrders, overdueOrders } = useMemo(() => {
    const today: LocalOrder[] = [];
    const overdue: LocalOrder[] = [];

    orders.forEach(o => {
      if (o.is_completed) return;
      if (o.due_date === todayStr) {
        today.push(o);
      } else if (o.due_date && o.due_date < todayStr) {
        overdue.push(o);
      }
    });

    return { todayOrders: today, overdueOrders: overdue };
  }, [orders, todayStr]);

  // B. Financial Reconciliation (Debt) calculations
  const { financialLedger, totalDebt } = useMemo(() => {
    const debtMap: Record<string, number> = {};
    let total = 0;

    orders.forEach(o => {
      if (o.payment_status === "pending" && o.parsed_order.amount !== null) {
        const name = o.customer || "Walk-in Customer";
        debtMap[name] = (debtMap[name] || 0) + o.parsed_order.amount;
        total += o.parsed_order.amount;
      }
    });

    const ledger = Object.entries(debtMap)
      .map(([name, amount]) => ({ name, amount }))
      .sort((a, b) => b.amount - a.amount);

    return { financialLedger: ledger, totalDebt: total };
  }, [orders]);

  // C. Historical Continuity list of customers
  const uniqueCustomers = useMemo(() => {
    const names = new Set<string>();
    orders.forEach(o => {
      if (o.customer) names.add(o.customer);
    });
    return Array.from(names);
  }, [orders]);

  // Select first customer as default for history if not set
  useEffect(() => {
    if (!selectedHistoryCustomer && uniqueCustomers.length > 0) {
      setSelectedHistoryCustomer(uniqueCustomers[0]);
    }
  }, [uniqueCustomers, selectedHistoryCustomer]);

  // Last order details for selected history customer
  const lastCustomerOrder = useMemo(() => {
    if (!selectedHistoryCustomer) return null;
    const customerOrders = orders
      .filter(o => o.customer === selectedHistoryCustomer)
      .sort((a, b) => b.created_at - a.created_at); // Sort descending chronologically
    return customerOrders[0] || null;
  }, [orders, selectedHistoryCustomer]);

  // D. Capacity Planning calculations (rolling 7-day workload)
  const capacityMetrics = useMemo(() => {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    const end = new Date(start);
    end.setDate(end.getDate() + 6); // 7-day rolling window

    let totalItemsQuantity = 0;
    orders.forEach(o => {
      if (o.is_completed) return;
      if (o.due_date) {
        const dueDate = new Date(o.due_date);
        if (dueDate >= start && dueDate <= end) {
          o.parsed_order.items.forEach(item => {
            totalItemsQuantity += item.quantity;
          });
        }
      }
    });

    const targetCapacity = 60; // Max items/tiffins/pieces per week
    const percentage = Math.min(100, Math.round((totalItemsQuantity / targetCapacity) * 100));

    return { totalItemsQuantity, targetCapacity, percentage };
  }, [orders]);

  // Handler to parse and store order
  const handleProcessOrder = async () => {
    if (!inputText.trim()) return;
    setIsProcessing(true);
    try {
      // 1. Hybrid routing pipeline
      const parsedRecord = await parseMessage(inputText);
      // 2. Persist in Dexie (with automatic event logging)
      await createOrder(inputText, parsedRecord);
      setInputText("");
    } catch (e) {
      console.error("Order processing failed:", e);
    } finally {
      setIsProcessing(false);
    }
  };

  // Toggles network state for visual testing
  const toggleNetworkSimulation = () => {
    setOnlineStatus(prev => !prev);
  };

  // Simulates a sync update conflict to demonstrate Causality logs & Conflict resolution UI
  const handleSimulateConflict = async () => {
    if (orders.length === 0) {
      alert("Please add at least one order first to simulate a conflict.");
      return;
    }
    
    // Choose the first active order
    const targetOrder = orders[0];
    const remoteNodeId = "device_tablet_99";
    const remoteTimestamp = `${Date.now() + 1000}:0:${remoteNodeId}`;

    // Create concurrent modification event for amount field
    const remoteAmountEvent: EventLogEntry = {
      id: crypto.randomUUID(),
      timestamp: remoteTimestamp,
      order_id: targetOrder.id,
      action: "UPDATE",
      field: "amount",
      value: (targetOrder.parsed_order.amount || 0) + 150, // Different amount
      node_id: remoteNodeId
    };

    alert(`Simulating conflict! Replaying a remote amount change from Tablet node for order: ${targetOrder.customer || "Unknown"}`);
    
    // Replay this remote event. Since the order is unsynced locally, it triggers a conflict!
    await replayEvents([remoteAmountEvent]);
    setIsConflictModalOpen(true);
  };

  return (
    <div className={styles.container}>
      {/* 1. Header Area */}
      <header className={styles.header}>
        <div className={styles.titleArea}>
          <h1 className={styles.title}>Offline Order Console</h1>
          <span className={`${styles.badge} ${onlineStatus ? styles.badgeOnline : styles.badgeOffline}`}>
            {onlineStatus ? "Online (LLM API)" : "Offline (Local Fallback)"}
          </span>
        </div>
        <div className={styles.controls}>
          <button className={`${styles.button} ${styles.buttonSecondary}`} onClick={toggleNetworkSimulation}>
            Mock Network Status
          </button>
          <button className={`${styles.button} ${styles.buttonSecondary}`} onClick={handleSimulateConflict}>
            Simulate Sync Conflict
          </button>
          <span style={{ fontSize: "11px", color: "var(--text-muted)" }}>
            Node ID: {typeof window !== "undefined" ? localStorage.getItem("hlc_node_id") || "loading..." : ""}
          </span>
        </div>
      </header>

      {/* 2. Conflict Banner warning */}
      {conflicts.length > 0 && (
        <div className={styles.conflictBanner}>
          <span>⚠️ {conflicts.length} Sync Conflict(s) Detected! Replay paused on concurrent offline edits.</span>
          <button className={`${styles.button} ${styles.buttonWarning}`} onClick={() => setIsConflictModalOpen(true)}>
            Resolve Conflicts
          </button>
        </div>
      )}

      {/* 3. Main Dashboard Workspace */}
      <div className={styles.mainGrid}>
        {/* Left Pane (Ingest & Lists) */}
        <div className={styles.leftPane}>
          {/* Quick Ingest Box */}
          <div className={styles.card}>
            <div className={styles.ingestBox}>
              <h3 style={{ fontSize: "14px", fontWeight: "600" }}>Raw Order Message Ingestion</h3>
              <textarea
                className={styles.textarea}
                placeholder="Paste WhatsApp Hinglish/Devanagari order here... (e.g. '2 kg aaloo and 1 packet milk kal de dena. Rs 150 total.')"
                value={inputText}
                onChange={e => setInputText(e.target.value)}
              />
              <button className={styles.button} onClick={handleProcessOrder} disabled={isProcessing}>
                {isProcessing ? "Processing NLP..." : "Parse & Log Order"}
              </button>
            </div>
          </div>

          {/* Active Orders List */}
          <div className={styles.card} style={{ flex: 1 }}>
            <h3 style={{ fontSize: "14px", fontWeight: "600", marginBottom: "8px" }}>Active Orders ({orders.length})</h3>
            <div className={styles.orderList}>
              {orders.length === 0 ? (
                <div style={{ textAlign: "center", color: "var(--text-muted)", fontSize: "12px", marginTop: "24px" }}>
                  No active orders recorded locally.
                </div>
              ) : (
                orders.map(o => (
                  <div key={o.id} className={styles.orderCard}>
                    <div className={styles.orderCardHeader}>
                      <span className={styles.customerName}>{o.customer || "Walk-in Customer"}</span>
                      <span className={styles.orderDate}>Due: {o.due_date || "N/A"}</span>
                    </div>
                    <div className={styles.orderItems}>
                      {o.parsed_order.items.map((item, idx) => (
                        <div key={idx}>
                          • {item.quantity} {item.attributes?.unit || "piece"} - {item.description}
                        </div>
                      ))}
                    </div>
                    <div className={styles.orderFooter}>
                      <span className={styles.amount}>
                        {o.parsed_order.amount !== null ? `₹${o.parsed_order.amount}` : "No Amount"}
                      </span>
                      <div className={styles.statusIndicator}>
                        {/* Toggle completion status button */}
                        <button 
                          className={`${styles.button} ${styles.buttonSecondary}`} 
                          style={{ padding: "2px 6px", fontSize: "10px" }}
                          onClick={() => toggleOrderCompletion(o.id)}
                        >
                          {o.is_completed ? "✓ Done" : "Active"}
                        </button>
                        {/* Toggle payment status button */}
                        <button 
                          className={`${styles.button} ${styles.buttonSecondary}`} 
                          style={{ 
                            padding: "2px 6px", 
                            fontSize: "10px", 
                            color: o.payment_status === "paid" ? "var(--accent-success)" : "var(--accent-warning)" 
                          }}
                          onClick={() => togglePaymentStatus(o.id)}
                        >
                          {o.payment_status === "paid" ? "Paid" : "Unpaid"}
                        </button>
                        {/* Clarification alert indicator */}
                        {o.parsed_order.needs_clarification && (
                          <span style={{ color: "var(--accent-warning)", fontSize: "13px" }} title="Needs Clarification">⚠️</span>
                        )}
                        {/* Sync status indicator */}
                        <span 
                          style={{ 
                            fontSize: "8px", 
                            color: o.sync_status === "synced" ? "var(--accent-success)" : "var(--accent-warning)" 
                          }}
                          title={`Sync Status: ${o.sync_status}`}
                        >
                          ●
                        </span>
                      </div>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>

        {/* Right Pane (Dashboard Widgets) */}
        <div className={styles.rightPane}>
          {/* Widget A: Temporal Triage */}
          <div className={styles.card}>
            <div className={styles.widgetHeader}>
              <span className={styles.widgetTitle}>⏱️ Temporal Triage</span>
              <span className={styles.badge} style={{ background: "rgba(255, 255, 255, 0.05)" }}>
                Today / Overdue
              </span>
            </div>
            <div className={styles.widgetContent}>
              <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                <span style={{ fontSize: "11px", fontWeight: "600", color: "var(--accent-danger)" }}>OVERDUE INCOMPLETE</span>
                {overdueOrders.length === 0 ? (
                  <span style={{ fontSize: "12px", color: "var(--text-muted)" }}>No overdue orders. Good job!</span>
                ) : (
                  overdueOrders.map(o => (
                    <div key={o.id} className={`${styles.dueItem} ${styles.dueOverdue}`}>
                      <div className={styles.dueItemText}>
                        <strong>{o.customer || "Walk-in"}</strong>
                        <span>{o.parsed_order.items.map(i => `${i.quantity} ${i.description}`).join(", ")}</span>
                      </div>
                      <span>Due: {o.due_date}</span>
                    </div>
                  ))
                )}

                <span style={{ fontSize: "11px", fontWeight: "600", color: "var(--accent-warning)", marginTop: "12px" }}>DUE TODAY</span>
                {todayOrders.length === 0 ? (
                  <span style={{ fontSize: "12px", color: "var(--text-muted)" }}>No tasks due today.</span>
                ) : (
                  todayOrders.map(o => (
                    <div key={o.id} className={`${styles.dueItem} ${styles.dueToday}`}>
                      <div className={styles.dueItemText}>
                        <strong>{o.customer || "Walk-in"}</strong>
                        <span>{o.parsed_order.items.map(i => `${i.quantity} ${i.description}`).join(", ")}</span>
                      </div>
                      <span>Today</span>
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>

          {/* Widget B: Financial Reconciliation */}
          <div className={styles.card}>
            <div className={styles.widgetHeader}>
              <span className={styles.widgetTitle}>💳 Outstanding Ledgers</span>
              <span className={styles.badge} style={{ background: "rgba(6, 182, 212, 0.15)", color: "var(--accent-secondary)" }}>
                Total: ₹{totalDebt}
              </span>
            </div>
            <div className={styles.widgetContent}>
              {financialLedger.length === 0 ? (
                <div style={{ textAlign: "center", color: "var(--text-muted)", fontSize: "12px", marginTop: "24px" }}>
                  All accounts settled. No pending debt!
                </div>
              ) : (
                financialLedger.map((ledger, idx) => (
                  <div key={idx} className={styles.debtItem}>
                    <span>{ledger.name}</span>
                    <strong style={{ color: "var(--accent-danger)" }}>₹{ledger.amount}</strong>
                  </div>
                ))
              )}
            </div>
          </div>

          {/* Widget C: Historical Continuity */}
          <div className={styles.card}>
            <div className={styles.widgetHeader}>
              <span className={styles.widgetTitle}>📋 Historical Continuity</span>
            </div>
            <div className={styles.widgetContent}>
              {uniqueCustomers.length === 0 ? (
                <div style={{ textAlign: "center", color: "var(--text-muted)", fontSize: "12px", marginTop: "24px" }}>
                  No customer profiles found.
                </div>
              ) : (
                <>
                  <select
                    className={styles.historySelector}
                    value={selectedHistoryCustomer}
                    onChange={e => setSelectedHistoryCustomer(e.target.value)}
                  >
                    {uniqueCustomers.map((c, i) => (
                      <option key={i} value={c}>
                        {c}
                      </option>
                    ))}
                  </select>

                  {lastCustomerOrder ? (
                    <div className={styles.historyDetails}>
                      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "6px" }}>
                        <strong>Last Order Record</strong>
                        <span style={{ fontSize: "10px", color: "var(--text-muted)" }}>
                          {new Date(lastCustomerOrder.created_at).toLocaleDateString()}
                        </span>
                      </div>
                      <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
                        {lastCustomerOrder.parsed_order.items.map((item, idx) => (
                          <div key={idx} style={{ padding: "4px 0", borderBottom: "1px solid rgba(255,255,255,0.02)" }}>
                            <strong>{item.quantity} {item.attributes?.unit || "piece"}</strong> - {item.description}
                            {item.attributes && Object.keys(item.attributes).filter(k => k !== "unit").length > 0 && (
                              <div style={{ fontSize: "10px", color: "var(--text-muted)", marginTop: "2px" }}>
                                Specs: {JSON.stringify(item.attributes)}
                              </div>
                            )}
                          </div>
                        ))}
                      </div>
                    </div>
                  ) : (
                    <span style={{ fontSize: "12px", color: "var(--text-muted)" }}>No history found for X.</span>
                  )}
                </>
              )}
            </div>
          </div>

          {/* Widget D: Capacity Planning */}
          <div className={styles.card}>
            <div className={styles.widgetHeader}>
              <span className={styles.widgetTitle}>📊 Weekly Capacity</span>
              <span className={styles.badge} style={{ background: "rgba(255, 255, 255, 0.05)" }}>
                7-Day Rolling
              </span>
            </div>
            <div className={styles.widgetContent} style={{ display: "flex", flexDirection: "column", justifyContent: "center" }}>
              <div className={styles.capacityVal}>
                {capacityMetrics.totalItemsQuantity} / {capacityMetrics.targetCapacity}
              </div>
              <div className={styles.capacityBarContainer}>
                <div 
                  className={styles.capacityBar} 
                  style={{ 
                    width: `${capacityMetrics.percentage}%`,
                    background: capacityMetrics.percentage > 85 ? "var(--accent-danger)" : "linear-gradient(to right, var(--accent-secondary), var(--accent-primary))"
                  }}
                />
              </div>
              <div className={styles.capacityInfo}>
                {capacityMetrics.percentage}% of weekly capacity committed. 
                {capacityMetrics.percentage > 85 && <div style={{ color: "var(--accent-danger)", fontWeight: "600", marginTop: "4px" }}>⚠️ High Workload Warning!</div>}
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* 4. Conflict Resolution Dialog Modal */}
      {isConflictModalOpen && conflicts.length > 0 && (
        <div className={styles.modalBackdrop}>
          <div className={styles.modal}>
            <h2 style={{ fontSize: "16px", fontWeight: "700", color: "var(--accent-warning)" }}>
              ⚠️ Resolve Offline Synchronization Conflicts
            </h2>
            <p style={{ fontSize: "12px", color: "var(--text-secondary)" }}>
              Concurrent modifications were detected while offline. Select the authoritative value for each field below:
            </p>

            <div style={{ display: "flex", flexDirection: "column", gap: "12px", maxHeight: "300px", overflowY: "auto" }}>
              {conflicts.map(conflict => (
                <div key={conflict.id} className={styles.conflictItem}>
                  <div style={{ fontSize: "12px", fontWeight: "600", borderBottom: "1px solid rgba(255,255,255,0.04)", paddingBottom: "4px" }}>
                    Field: <span style={{ color: "var(--accent-secondary)" }}>{conflict.field}</span> (Order ID: {conflict.order_id.substring(0, 8)})
                  </div>
                  
                  <div className={styles.conflictColumnGrid}>
                    {/* Option A: Local Value */}
                    <div 
                      className={styles.conflictOption} 
                      onClick={() => resolveConflict(conflict.order_id, conflict.field, conflict.local_value)}
                    >
                      <span className={styles.conflictLabel}>Local Device</span>
                      <span className={styles.conflictValue}>
                        {typeof conflict.local_value === "object" ? JSON.stringify(conflict.local_value) : String(conflict.local_value)}
                      </span>
                      <span className={styles.conflictTime}>Time: {conflict.local_timestamp.split(":")[0]}</span>
                    </div>

                    {/* Option B: Remote Value */}
                    <div 
                      className={styles.conflictOption} 
                      onClick={() => resolveConflict(conflict.order_id, conflict.field, conflict.remote_value)}
                    >
                      <span className={styles.conflictLabel}>Sync Peer (Remote)</span>
                      <span className={styles.conflictValue}>
                        {typeof conflict.remote_value === "object" ? JSON.stringify(conflict.remote_value) : String(conflict.remote_value)}
                      </span>
                      <span className={styles.conflictTime}>Time: {conflict.remote_timestamp.split(":")[0]}</span>
                    </div>
                  </div>
                </div>
              ))}
            </div>

            <button 
              className={styles.button} 
              style={{ alignSelf: "flex-end" }} 
              onClick={() => setIsConflictModalOpen(false)}
            >
              Close Resolver
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
