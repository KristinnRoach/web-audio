# Audio Node Factory Pattern

## Core Pattern

All audio nodes must use async factory functions for creation. Never export constructors directly.

## Interface Definition

```typescript
export interface LibNode {
  readonly nodeId: NodeID;
  readonly nodeType: NodeType;
  init(): Promise<void>;
  dispose(): void;
}
```

## Implementation Template

```typescript
class NodeName implements LibNode {
  readonly nodeId: NodeID;
  readonly nodeType = 'node-name' as const;

  constructor(
    private context: AudioContext,
    ...args
  ) {
    this.nodeId = createNodeId('node-name');
    // Only synchronous setup here
  }

  async init(): Promise<void> {
    // Create child nodes
    this.childNode = new ChildNode(this.context);

    // Initialize children first
    await this.childNode.init();

    // Initialize self after children
    this.setupConnections();
    this.setupParameters();
  }

  dispose(): void {
    // Cleanup logic
  }
}

// Only export factory function
export async function createNodeName(
  context: AudioContext,
  ...args
): Promise<NodeName> {
  const node = new NodeName(context, ...args);
  await node.init();
  return node;
}
```

## Rules

1. Constructor does synchronous setup only
2. `init()` method handles all async initialization
3. Child nodes must `await init()` before parent initialization
4. Factory function calls `init()` before returning
5. Errors in `init()` should throw, not return boolean
6. Never export the class constructor directly
7. All factory functions are async for consistency

## Usage Pattern

```typescript
// Single node
const node = await createNodeName(context, params);

// Multiple nodes in parallel
const [nodeA, nodeB] = await Promise.all([
  createNodeA(context),
  createNodeB(context),
]);

// Error handling
try {
  const node = await createComplexNode(context);
} catch (error) {
  console.error('Node creation failed:', error);
}
```

## Error Handling in Complex Initialization

```typescript
async init(): Promise<void> {
  try {
    this.childA = new ChildA(this.context);
    await this.childA.init();

    this.childB = new ChildB(this.context);
    await this.childB.init();

    this.setupConnections();
  } catch (error) {
    // Cleanup any partial initialization
    this.childA?.dispose();
    throw new Error(`Failed to initialize ${this.nodeType}: ${error.message}`);
  }
}
```
