export interface HLCTimestamp {
  physical: number;
  logical: number;
  nodeId: string;
}

/**
 * Parses an HLC string representation into its constituent components.
 * Format: `<physical_ms>:<logical_counter>:<node_id>`
 */
export function parseHLC(hlcString: string): HLCTimestamp {
  const parts = hlcString.split(":");
  if (parts.length < 3) {
    throw new Error(`Invalid HLC format: ${hlcString}`);
  }
  return {
    physical: parseInt(parts[0], 10),
    logical: parseInt(parts[1], 10),
    nodeId: parts.slice(2).join(":") // Node ID might contain colons in rare cases
  };
}

/**
 * Formats an HLCTimestamp object into a compound HLC string.
 */
export function formatHLC(hlc: HLCTimestamp): string {
  return `${hlc.physical}:${hlc.logical}:${hlc.nodeId}`;
}

/**
 * Compares two HLC strings.
 * Returns:
 *   - negative number if hlcA happens before hlcB
 *   - positive number if hlcA happens after hlcB
 *   - 0 if they are identical
 */
export function compareHLC(hlcA: string, hlcB: string): number {
  const a = parseHLC(hlcA);
  const b = parseHLC(hlcB);
  
  if (a.physical !== b.physical) {
    return a.physical - b.physical;
  }
  if (a.logical !== b.logical) {
    return a.logical - b.logical;
  }
  return a.nodeId.localeCompare(b.nodeId);
}

/**
 * Hybrid Logical Clock (HLC) Implementation
 */
export class HLC {
  private lastHLC: HLCTimestamp;
  private nodeId: string;

  constructor(nodeId: string) {
    this.nodeId = nodeId;
    this.lastHLC = {
      physical: 0,
      logical: 0,
      nodeId: nodeId
    };
  }

  getNodeId(): string {
    return this.nodeId;
  }

  /**
   * Increments the logical clock based on local activity
   * Returns the new HLC string representation
   */
  increment(): string {
    const systemTime = Date.now();
    const lastPhys = this.lastHLC.physical;
    
    const nextPhys = Math.max(systemTime, lastPhys);
    let nextLog = 0;
    
    if (nextPhys === lastPhys) {
      nextLog = this.lastHLC.logical + 1;
    } else {
      nextLog = 0;
    }
    
    this.lastHLC = {
      physical: nextPhys,
      logical: nextLog,
      nodeId: this.nodeId
    };
    
    return formatHLC(this.lastHLC);
  }

  /**
   * Updates the local logical clock based on a received remote timestamp
   * Returns the new HLC string representation
   */
  receive(remoteHlcString: string): string {
    const remote = parseHLC(remoteHlcString);
    const systemTime = Date.now();
    
    const nextPhys = Math.max(systemTime, this.lastHLC.physical, remote.physical);
    let nextLog = 0;
    
    if (nextPhys === this.lastHLC.physical && nextPhys === remote.physical) {
      nextLog = Math.max(this.lastHLC.logical, remote.logical) + 1;
    } else if (nextPhys === this.lastHLC.physical) {
      nextLog = this.lastHLC.logical + 1;
    } else if (nextPhys === remote.physical) {
      nextLog = remote.logical + 1;
    } else {
      nextLog = 0;
    }
    
    this.lastHLC = {
      physical: nextPhys,
      logical: nextLog,
      nodeId: this.nodeId
    };
    
    return formatHLC(this.lastHLC);
  }
}

/**
 * Gets or creates a persistent device Node ID
 */
export function getOrCreateNodeId(): string {
  if (typeof window === "undefined") return "server_node";
  let id = localStorage.getItem("hlc_node_id");
  if (!id) {
    // Generate a unique 8-character device suffix
    const suffix = Math.random().toString(36).substring(2, 10);
    id = `device_${suffix}`;
    localStorage.setItem("hlc_node_id", id);
  }
  return id;
}

let globalHLCInstance: HLC | null = null;

export function getGlobalHLC(): HLC {
  if (!globalHLCInstance) {
    globalHLCInstance = new HLC(getOrCreateNodeId());
  }
  return globalHLCInstance;
}
