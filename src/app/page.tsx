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
  replayEvents,
  clearAllData,
  triggerSync
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
  const [nodeId, setNodeId] = useState<string>("");
  const [language, setLanguage] = useState<"en" | "hi">("en");
  const [installPrompt, setInstallPrompt] = useState<any>(null);

  // Monitor network status reactively and load node ID safely on client
  useEffect(() => {
    if (typeof window !== "undefined") {
      setOnlineStatus(navigator.onLine);
      setNodeId(localStorage.getItem("hlc_node_id") || "device_node");
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

  // Listen to PWA installation prompts
  useEffect(() => {
    if (typeof window !== "undefined") {
      const handleBeforePrompt = (e: Event) => {
        e.preventDefault();
        setInstallPrompt(e);
      };
      window.addEventListener("beforeinstallprompt", handleBeforePrompt);
      return () => {
        window.removeEventListener("beforeinstallprompt", handleBeforePrompt);
      };
    }
  }, []);

  // Periodic client-side background sync
  useEffect(() => {
    // Run initial sync
    triggerSync().catch(err => console.error("Initial sync failed:", err));

    // Poll every 3 seconds when online
    const interval = setInterval(() => {
      triggerSync().catch(err => console.error("Interval sync failed:", err));
    }, 3000);

    return () => clearInterval(interval);
  }, []);

  const handleInstallApp = async () => {
    if (installPrompt) {
      installPrompt.prompt();
      const { outcome } = await installPrompt.userChoice;
      if (outcome === "accepted") {
        setInstallPrompt(null);
      }
    } else {
      alert(language === "en" 
        ? "To install Resolv on your device:\n1. Open your browser menu (⋮ or share icon).\n2. Select 'Add to Home Screen' or 'Install App'."
        : "अपने डिवाइस पर Resolv इंस्टॉल करने के लिए:\n1. अपने ब्राउज़र मेनू (⋮ या शेयर बटन) पर जाएं।\n2. 'Add to Home Screen' या 'Install App' पर टैप करें।"
      );
    }
  };

  // 1. Live Query active orders (live update from Dexie)
  const orders = useLiveQuery(getActiveOrders) || [];

  // Filter active and completed orders
  const { activeOrders, completedOrders } = useMemo(() => {
    return {
      activeOrders: orders.filter(o => !o.is_completed),
      completedOrders: orders.filter(o => o.is_completed)
    };
  }, [orders]);

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

  const handleClearAll = async () => {
    if (confirm(language === "en" ? "Are you sure you want to clear all orders?" : "क्या आप सचमुच सभी ऑर्डर्स मिटाना चाहते हैं?")) {
      try {
        await clearAllData();
        setSelectedHistoryCustomer("");
      } catch (err) {
        console.error("Failed to clear data:", err);
      }
    }
  };
  const t = {
    en: {
      title: "Paste WhatsApp Messages",
      placeholder: "Paste WhatsApp messages here... (e.g. 'kurta silai 2 piece maroon color, waist 32, parso tak')",
      parseBtn: "Save Order",
      parsing: "Saving...",
      activeOrders: "Current Orders",
      noOrders: "No active orders.",
      due: "Delivery",
      noAmount: "No Price",
      dueToday: "Due Today",
      overdue: "Late / Overdue",
      temporalTriage: "⏱️ Work Deadlines",
      outstandingLedger: "💳 Who Owes Money",
      settled: "No pending debt!",
      historicalContinuity: "📋 Customer Past Specs",
      lastOrderRecord: "Last Order",
      noHistory: "No customers yet.",
      noHistoryForCustomer: "No history found.",
      weeklyCapacity: "📊 Weekly Work Limit",
      rolling: "7-Day Load",
      capacityCommitted: "committed",
      highWorkload: "⚠️ High Workload Warning!",
      unpaid: "Unpaid",
      paid: "Paid"
    },
    hi: {
      title: "व्हाट्सएप मैसेज पेस्ट करें",
      placeholder: "यहाँ व्हाट्सएप मैसेज पेस्ट करें... (जैसे: 'कुर्ता सिलाई २ पीस मैरून कलर, कमर ३२, परसों तक')",
      parseBtn: "ऑर्डर सुरक्षित करें (Save)",
      parsing: "सुरक्षित हो रहा है...",
      activeOrders: "चालू ऑर्डर्स",
      noOrders: "कोई चालू ऑर्डर नहीं है।",
      due: "तारीख",
      noAmount: "कीमत नहीं",
      dueToday: "आज ही देना है",
      overdue: "तारीख निकल चुकी है",
      temporalTriage: "⏱️ डिलीवरी की तारीख",
      outstandingLedger: "💳 उधारी खाता",
      settled: "कोई उधारी नहीं है!",
      historicalContinuity: "📋 पुराना माप / रिकॉर्ड",
      lastOrderRecord: "आखिरी ऑर्डर",
      noHistory: "कोई ग्राहक रिकॉर्ड नहीं मिला।",
      noHistoryForCustomer: "कोई पुराना रिकॉर्ड नहीं मिला।",
      weeklyCapacity: "📊 हफ़्ते का काम",
      rolling: "७ दिन का लोड",
      capacityCommitted: "काम दर्ज है",
      highWorkload: "⚠️ बहुत ज़्यादा काम!",
      unpaid: "बाकी (Unpaid)",
      paid: "नकद (Paid)"
    }
  }[language];
  return (
    <div className={styles.container}>
      {/* 1. Header Area */}
      <header className={styles.header}>
        <div className={styles.titleArea}>
          <h1 className={styles.title}>Resolv Order Console</h1>
          <div style={{ display: "flex", gap: "10px", alignItems: "center" }}>
            <button 
              className={styles.button} 
              style={{ 
                backgroundColor: "#16a34a", 
                color: "#ffffff", 
                border: "2px solid #15803d",
                fontSize: "14px", 
                fontWeight: "800",
                minHeight: "44px",
                padding: "4px 12px"
              }} 
              onClick={handleInstallApp}
            >
              📥 {language === "en" ? "Download App" : "ऐप डाउनलोड करें"}
            </button>
            <button 
              className={styles.button} 
              style={{ 
                backgroundColor: "#2563eb", 
                color: "#ffffff", 
                border: "2px solid #1d4ed8",
                fontSize: "14px", 
                fontWeight: "800",
                minHeight: "44px",
                padding: "4px 12px"
              }} 
              onClick={() => setLanguage(language === "en" ? "hi" : "en")}
            >
              {language === "en" ? "English / हिंदी" : "हिंदी / English"}
            </button>
            <button 
              className={styles.button} 
              style={{ 
                backgroundColor: "#dc2626", 
                color: "#ffffff", 
                border: "2px solid #b91c1c",
                fontSize: "14px", 
                fontWeight: "800",
                minHeight: "44px",
                padding: "4px 12px"
              }} 
              onClick={handleClearAll}
            >
              🗑️ {language === "en" ? "Clear All" : "सब मिटाएं"}
            </button>
          </div>
        </div>
        <div className={styles.controls}>
          <span className={`${styles.badge} ${onlineStatus ? styles.badgeOnline : styles.badgeOffline}`}>
            {onlineStatus ? "Online (LLM API)" : "Offline (Local Fallback)"}
          </span>
          <span style={{ fontSize: "11px", color: "var(--text-muted)", marginLeft: "auto" }}>
            Node ID: {nodeId || "loading..."}
          </span>
        </div>
        <div style={{ marginTop: "12px", borderTop: "1.5px solid #000000", paddingTop: "12px" }}>
          <p style={{ fontSize: "14px", fontWeight: "600", color: "var(--text-secondary)", lineHeight: "1.5" }}>
            {language === "en" 
              ? "Resolv helps you save and manage orders from WhatsApp. Paste any message here to get item details, prices, and delivery dates instantly. Works even without internet!"
              : "Resolv व्हाट्सएप ऑर्डर्स को आसानी से सुरक्षित रखने और ट्रैक करने का ऐप है। कोई भी मैसेज पेस्ट करें और सामान, कीमतें तथा डिलीवरी की तारीखें तुरंत पाएं। बिना इंटरनेट भी काम करता है!"}
          </p>
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
              <h3 style={{ fontSize: "16px", fontWeight: "800", color: "#000000" }}>{t.title}</h3>
              <textarea
                className={styles.textarea}
                placeholder={t.placeholder}
                value={inputText}
                onChange={e => setInputText(e.target.value)}
              />
              <button className={styles.button} style={{ fontSize: "16px", minHeight: "48px" }} onClick={handleProcessOrder} disabled={isProcessing}>
                {isProcessing ? t.parsing : t.parseBtn}
              </button>
            </div>
          </div>

          {/* Active Orders List */}
          <div className={styles.card}>
            <h3 style={{ fontSize: "16px", fontWeight: "800", color: "#000000" }}>{t.activeOrders} ({activeOrders.length})</h3>
            <div className={styles.orderList}>
              {activeOrders.length === 0 ? (
                <div style={{ textAlign: "center", color: "var(--text-muted)", fontSize: "14px", padding: "20px 0" }}>
                  {t.noOrders}
                </div>
              ) : (
                activeOrders.map(o => (
                  <div key={o.id} className={styles.orderCard}>
                    <div className={styles.orderCardHeader}>
                      <span className={styles.customerName}>{o.customer || (language === "en" ? "Walk-in Customer" : "बिना नाम का ग्राहक")}</span>
                      <span className={styles.orderDate}>{t.due}: {o.due_date || "N/A"}</span>
                    </div>
                    <div className={styles.orderItems}>
                      {o.parsed_order.items.map((item, idx) => (
                        <div key={idx} style={{ marginBottom: "4px" }}>
                          • {item.quantity} {item.attributes?.unit || (language === "en" ? "piece" : "पीस")} - <strong>{item.description}</strong>
                          {item.attributes && Object.keys(item.attributes).filter(k => k !== "unit").length > 0 && (
                            <span style={{ fontSize: "11px", color: "var(--accent-secondary)", marginLeft: "6px" }}>
                              ({Object.entries(item.attributes).filter(([k]) => k !== "unit").map(([k, v]) => `${k}: ${v}`).join(", ")})
                            </span>
                          )}
                        </div>
                      ))}
                    </div>
                    <div className={styles.orderFooter}>
                      <span className={styles.amount}>
                        {o.parsed_order.amount !== null ? `₹${o.parsed_order.amount}` : t.noAmount}
                      </span>
                      <div className={styles.statusIndicator}>
                        {/* Toggle completion status button */}
                        <button 
                          className={`${styles.button} ${styles.buttonSecondary}`} 
                          style={{ minHeight: "36px", padding: "6px 12px", fontSize: "12px", fontWeight: "bold" }}
                          onClick={() => toggleOrderCompletion(o.id)}
                        >
                          {o.is_completed ? (language === "en" ? "✓ Done" : "✓ पूरा") : (language === "en" ? "Active" : "चालू")}
                        </button>
                        {/* Toggle payment status button */}
                        <button 
                          className={`${styles.button} ${o.payment_status === "paid" ? styles.buttonSecondary : styles.buttonWarning}`} 
                          style={{ 
                            minHeight: "36px", 
                            padding: "6px 12px", 
                            fontSize: "12px", 
                            fontWeight: "bold",
                            color: o.payment_status === "paid" ? "var(--accent-success)" : "#ffffff"
                          }}
                          onClick={() => togglePaymentStatus(o.id)}
                        >
                          {o.payment_status === "paid" ? t.paid : t.unpaid}
                        </button>
                        {/* Clarification alert indicator */}
                        {o.parsed_order.needs_clarification && (
                          <span style={{ fontSize: "18px" }} title="Needs Clarification">⚠️</span>
                        )}
                        {/* Sync status indicator */}
                        <span 
                          style={{ 
                            fontSize: "12px", 
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
              <span className={styles.widgetTitle}>{t.temporalTriage}</span>
            </div>
            <div className={styles.widgetContent}>
              <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
                <span style={{ fontSize: "12px", fontWeight: "800", color: "#b91c1c" }}>{t.overdue.toUpperCase()}</span>
                {overdueOrders.length === 0 ? (
                  <span style={{ fontSize: "13px", color: "var(--text-muted)" }}>{language === "en" ? "No overdue orders. Good job!" : "कोई काम बाकी नहीं है। बहुत बढ़िया!"}</span>
                ) : (
                  overdueOrders.map(o => (
                    <div key={o.id} className={`${styles.dueItem} ${styles.dueOverdue}`}>
                      <div className={styles.dueItemText}>
                        <strong>{o.customer || (language === "en" ? "Walk-in" : "बिना नाम")}</strong>
                        <span>{o.parsed_order.items.map(i => `${i.quantity} ${i.description}`).join(", ")}</span>
                      </div>
                      <span>{t.due}: {o.due_date}</span>
                    </div>
                  ))
                )}

                <span style={{ fontSize: "12px", fontWeight: "800", color: "#b45309", marginTop: "12px" }}>{t.dueToday.toUpperCase()}</span>
                {todayOrders.length === 0 ? (
                  <span style={{ fontSize: "13px", color: "var(--text-muted)" }}>{language === "en" ? "No tasks due today." : "आज के लिए कोई डिलीवरी नहीं है।"}</span>
                ) : (
                  todayOrders.map(o => (
                    <div key={o.id} className={`${styles.dueItem} ${styles.dueToday}`}>
                      <div className={styles.dueItemText}>
                        <strong>{o.customer || (language === "en" ? "Walk-in" : "बिना नाम")}</strong>
                        <span>{o.parsed_order.items.map(i => `${i.quantity} ${i.description}`).join(", ")}</span>
                      </div>
                      <span>{language === "en" ? "Today" : "आज"}</span>
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>

          {/* Widget B: Financial Reconciliation */}
          <div className={styles.card}>
            <div className={styles.widgetHeader} style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span className={styles.widgetTitle}>{t.outstandingLedger}</span>
              <span className={styles.badge} style={{ background: "#fee2e2", color: "#b91c1c", border: "1.5px solid #b91c1c", fontSize: "13px" }}>
                Total: ₹{totalDebt}
              </span>
            </div>
            <div className={styles.widgetContent}>
              {financialLedger.length === 0 ? (
                <div style={{ textAlign: "center", color: "var(--text-muted)", fontSize: "13px", padding: "12px 0" }}>
                  {t.settled}
                </div>
              ) : (
                financialLedger.map((ledger, idx) => (
                  <div key={idx} className={styles.debtItem}>
                    <span>{ledger.name}</span>
                    <strong style={{ color: "#b91c1c", fontSize: "16px" }}>₹{ledger.amount}</strong>
                  </div>
                ))
              )}
            </div>
          </div>

          {/* Widget C: Historical Continuity */}
          <div className={styles.card}>
            <div className={styles.widgetHeader}>
              <span className={styles.widgetTitle}>{t.historicalContinuity}</span>
            </div>
            <div className={styles.widgetContent}>
              {uniqueCustomers.length === 0 ? (
                <div style={{ textAlign: "center", color: "var(--text-muted)", fontSize: "13px", padding: "12px 0" }}>
                  {t.noHistory}
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
                      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "6px", borderBottom: "1px solid #e5e7eb", paddingBottom: "4px" }}>
                        <strong style={{ color: "#000" }}>{t.lastOrderRecord}</strong>
                        <span style={{ fontSize: "11px", fontWeight: "bold", color: "var(--text-muted)" }}>
                          {new Date(lastCustomerOrder.created_at).toLocaleDateString()}
                        </span>
                      </div>
                      <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
                        {lastCustomerOrder.parsed_order.items.map((item, idx) => (
                          <div key={idx} style={{ padding: "4px 0" }}>
                            <strong>{item.quantity} {item.attributes?.unit || "piece"}</strong> - {item.description}
                            {item.attributes && Object.keys(item.attributes).filter(k => k !== "unit").length > 0 && (
                              <div style={{ fontSize: "11px", color: "var(--text-muted)", marginTop: "4px" }}>
                                Specs: {Object.entries(item.attributes).filter(([k]) => k !== "unit").map(([k, v]) => `${k}: ${v}`).join(", ")}
                              </div>
                            )}
                          </div>
                        ))}
                      </div>
                    </div>
                  ) : (
                    <span style={{ fontSize: "13px", color: "var(--text-muted)" }}>{t.noHistoryForCustomer}</span>
                  )}
                </>
              )}
            </div>
          </div>

          {/* Widget D: Capacity Planning */}
          <div className={styles.card}>
            <div className={styles.widgetHeader}>
              <span className={styles.widgetTitle}>{t.weeklyCapacity}</span>
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
                    background: capacityMetrics.percentage > 85 ? "#b91c1c" : "#2563eb"
                  }}
                />
              </div>
              <div className={styles.capacityInfo}>
                {capacityMetrics.percentage}% {t.capacityCommitted}
                {capacityMetrics.percentage > 85 && <div style={{ color: "#b91c1c", fontWeight: "800", marginTop: "6px" }}>{t.highWorkload}</div>}
              </div>
            </div>
          </div>

          {/* Widget E: Completed Orders */}
          <div className={styles.card} style={{ gridColumn: "span 2" }}>
            <div className={styles.widgetHeader}>
              <span className={styles.widgetTitle}>✓ {language === "en" ? "Completed Orders" : "पूरे हो चुके ऑर्डर्स"} ({completedOrders.length})</span>
            </div>
            <div className={styles.widgetContent}>
              {completedOrders.length === 0 ? (
                <div style={{ textAlign: "center", color: "var(--text-muted)", fontSize: "14px", padding: "12px 0" }}>
                  {language === "en" ? "No completed orders yet." : "अभी तक कोई ऑर्डर पूरा नहीं हुआ है।"}
                </div>
              ) : (
                <div className={styles.orderList}>
                  {completedOrders.map(o => (
                    <div key={o.id} className={styles.orderCard} style={{ opacity: 0.8, background: "#f9fafb" }}>
                      <div className={styles.orderCardHeader}>
                        <span className={styles.customerName} style={{ textDecoration: "line-through", color: "var(--text-muted)" }}>
                          {o.customer || (language === "en" ? "Walk-in Customer" : "बिना नाम का ग्राहक")}
                        </span>
                        <span className={styles.orderDate}>{t.due}: {o.due_date || "N/A"}</span>
                      </div>
                      <div className={styles.orderItems} style={{ textDecoration: "line-through", color: "var(--text-muted)" }}>
                        {o.parsed_order.items.map((item, idx) => (
                          <div key={idx} style={{ marginBottom: "2px" }}>
                            • {item.quantity} {item.attributes?.unit || "piece"} - {item.description}
                          </div>
                        ))}
                      </div>
                      <div className={styles.orderFooter}>
                        <span className={styles.amount}>₹{o.parsed_order.amount || 0}</span>
                        <div className={styles.statusIndicator}>
                          <button 
                            className={`${styles.button} ${styles.buttonSecondary}`} 
                            style={{ minHeight: "36px", padding: "6px 12px", fontSize: "12px", fontWeight: "bold" }}
                            onClick={() => toggleOrderCompletion(o.id)}
                          >
                            🔄 {language === "en" ? "Make Active" : "चालू करें"}
                          </button>
                          <span style={{ fontSize: "12px", color: "var(--accent-success)", fontWeight: "bold" }}>
                            {language === "en" ? "Completed" : "पूर्ण"}
                          </span>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* 4. Conflict Resolution Dialog Modal */}
      {isConflictModalOpen && conflicts.length > 0 && (
        <div className={styles.modalBackdrop}>
          <div className={styles.modal}>
            <h2 style={{ fontSize: "16px", fontWeight: "700", color: "#b45309" }}>
              {language === "en" ? "⚠️ Resolve Offline Synchronization Conflicts" : "⚠️ ऑफ़लाइन सिंक विरोधों को सुलझाएं"}
            </h2>
            <p style={{ fontSize: "13px", color: "var(--text-secondary)" }}>
              {language === "en" ? "Concurrent modifications were detected while offline. Select the authoritative value for each field below:" : "ऑफ़लाइन रहते हुए एक से अधिक बदलाव किए गए थे। कृपया सही मान चुनें:"}
            </p>

            <div style={{ display: "flex", flexDirection: "column", gap: "12px", maxHeight: "300px", overflowY: "auto" }}>
              {conflicts.map(conflict => (
                <div key={conflict.id} className={styles.conflictItem}>
                  <div style={{ fontSize: "13px", fontWeight: "800", borderBottom: "1px solid #d97706", paddingBottom: "6px", color: "#000" }}>
                    {language === "en" ? "Field" : "बदलाव का विषय"}: <span style={{ color: "#2563eb" }}>{conflict.field}</span> (ID: {conflict.order_id.substring(0, 8)})
                  </div>
                  
                  <div className={styles.conflictColumnGrid}>
                    {/* Option A: Local Value */}
                    <div 
                      className={styles.conflictOption} 
                      onClick={() => resolveConflict(conflict.order_id, conflict.field, conflict.local_value)}
                    >
                      <span className={styles.conflictLabel}>
                        {conflict.field === "delete" 
                          ? (conflict.local_value === "delete" ? (language === "en" ? "Delete Order" : "ऑर्डर मिटाएं") : (language === "en" ? "Restore Order" : "ऑर्डर वापस लाएं"))
                          : (language === "en" ? "Local Device" : "इस फ़ोन का बदलाव")}
                      </span>
                      <span className={styles.conflictValue}>
                        {conflict.field === "delete"
                          ? (conflict.local_value === "delete" ? (language === "en" ? "Confirm Deletion" : "मिटाना पक्का करें") : (language === "en" ? "Keep Order & Apply Updates" : "ऑर्डर रखें और बदलाव लगाएं"))
                          : (typeof conflict.local_value === "object" ? JSON.stringify(conflict.local_value) : String(conflict.local_value))}
                      </span>
                      <span className={styles.conflictTime}>
                        {conflict.field === "delete" ? "" : `${language === "en" ? "Device" : "डिवाइस"}: ${conflict.local_timestamp}`}
                      </span>
                    </div>

                    {/* Option B: Remote Value */}
                    <div 
                      className={styles.conflictOption} 
                      onClick={() => resolveConflict(conflict.order_id, conflict.field, conflict.remote_value)}
                    >
                      <span className={styles.conflictLabel}>
                        {conflict.field === "delete" 
                          ? (conflict.remote_value === "delete" ? (language === "en" ? "Delete Order" : "ऑर्डर मिटाएं") : (language === "en" ? "Restore Order" : "ऑर्डर वापस लाएं"))
                          : (language === "en" ? "Sync Peer (Remote)" : "दूसरे फ़ोन का बदलाव")}
                      </span>
                      <span className={styles.conflictValue}>
                        {conflict.field === "delete"
                          ? (conflict.remote_value === "delete" ? (language === "en" ? "Confirm Deletion" : "मिटाना पक्का करें") : (language === "en" ? "Keep Order & Apply Updates" : "ऑर्डर रखें और बदलाव लगाएं"))
                          : (typeof conflict.remote_value === "object" ? JSON.stringify(conflict.remote_value) : String(conflict.remote_value))}
                      </span>
                      <span className={styles.conflictTime}>
                        {conflict.field === "delete" ? "" : `${language === "en" ? "Device" : "डिवाइस"}: ${conflict.remote_timestamp}`}
                      </span>
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
              {language === "en" ? "Close" : "बंद करें"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
