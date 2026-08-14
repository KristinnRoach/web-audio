// node-store.ts

import { LibNode, NodeType } from '@/nodes';

export type NodeID = string;

let newestId = -1;
const NodeRegistry = new Map<NodeID, LibNode>();

export const registerNode = (nodeType: NodeType, node: LibNode) => {
  const nodeId = `${++newestId}-${nodeType}`;
  NodeRegistry.set(nodeId, node);
  return nodeId;
};

export const unregisterNode = (nodeId: NodeID): void => {
  if (!NodeRegistry.delete(nodeId)) {
    console.debug('Attempted to unregister a non-existent Node ID: ', nodeId);
  }
};

export const getNodeById = (nodeId: NodeID): LibNode | null => {
  return NodeRegistry.get(nodeId) || null;
};

// Query methods
export const getNodesByType = (type: NodeType): LibNode[] => {
  return Array.from(NodeRegistry.values()).filter(
    (node) => node.nodeType === type
  );
};

export const getAllNodes = (): LibNode[] => Array.from(NodeRegistry.values());
export const getAllNodeIds = (): NodeID[] => Array.from(NodeRegistry.keys());

export const hasNode = (nodeId: NodeID): boolean => NodeRegistry.has(nodeId);

// Converters
export const idToNum = (nodeId: NodeID): number =>
  parseInt(nodeId.split('-')[0]);
export const numToId = (num: number, nodeType: NodeType): NodeID =>
  `${num}-${nodeType}`;
