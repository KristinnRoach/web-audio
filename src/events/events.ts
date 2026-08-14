import { NodeID } from '@/nodes/node-store';

export interface Message {
  readonly type: string;
  readonly senderId: NodeID;
  [key: string]: any; // Allow any additional properties in dev
}

export type MessageHandler<T> = (data: T) => void;

export interface MessageBus<T extends Message> {
  sendMessage(type: T['type'], data: Omit<T, 'type' | 'senderId'>): void;
  onMessage<K extends T['type']>(
    type: K,
    handler: MessageHandler<T>
  ): () => void;

  forwardFrom(
    source: {
      onMessage: (type: string, handler: MessageHandler<T>) => () => void;
    },
    messageTypes: string[],
    transform?: (msg: T) => any
  ): () => void;
}

export function createMessageBus<T extends Message>(
  senderId: NodeID
): MessageBus<T> {
  const handlers = new Map<string, Set<MessageHandler<T>>>();

  return {
    sendMessage(type, data) {
      const typeHandlers = handlers.get(type);
      if (typeHandlers) {
        const message = { type, senderId, ...data } as T;
        typeHandlers.forEach((handler) => handler(message));
      }
    },

    onMessage(type, handler) {
      if (!handlers.has(type)) {
        handlers.set(type, new Set());
      }
      const typeHandlers = handlers.get(type)!;
      typeHandlers.add(handler);
      return () => typeHandlers.delete(handler);
    },

    forwardFrom(source, messageTypes, transform) {
      const defaultTransform = (msg: T) => ({
        // sourceId: msg.senderId,
        ...msg,
      });

      const transformFn = transform || defaultTransform;

      const cleanupFns = messageTypes.map((type) =>
        source.onMessage(type, (msg: T) => {
          const transformedMsg = transformFn(msg);
          if (transformedMsg !== null) {
            this.sendMessage(transformedMsg.type, transformedMsg);
          }
        })
      );

      return () => cleanupFns.forEach((fn) => fn());
    },
  };
}
