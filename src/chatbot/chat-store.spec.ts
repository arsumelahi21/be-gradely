import {
  CHAT_TTL_MS,
  ChatStore,
  MAX_CHATS_PER_USER,
  MAX_MESSAGES_PER_CHAT,
  SWEEP_INTERVAL_MS,
} from './chat-store';

// The bounds are the whole point of an in-memory store, and nothing covered them.
describe('ChatStore', () => {
  let store: ChatStore;

  beforeEach(() => {
    store = new ChatStore();
  });

  it('keeps a chat owned by one user unreadable by another', () => {
    const chat = store.create('u1');
    expect(store.findById('u2', chat.id)).toBeNull();
    expect(store.list('u2')).toEqual([]);
  });

  it('caps chats per user, evicting the oldest', () => {
    for (let i = 0; i < MAX_CHATS_PER_USER + 5; i++) store.create('u1');
    expect(store.list('u1')).toHaveLength(MAX_CHATS_PER_USER);
  });

  it('caps messages per chat, dropping the oldest', () => {
    const chat = store.create('u1');
    for (let i = 0; i < MAX_MESSAGES_PER_CHAT + 10; i++) {
      store.addMessage('u1', chat.id, 'USER', `m${i}`);
    }
    const kept = store.findById('u1', chat.id)!.messages;
    expect(kept).toHaveLength(MAX_MESSAGES_PER_CHAT);
    expect(kept[kept.length - 1].content).toBe(`m${MAX_MESSAGES_PER_CHAT + 9}`);
  });

  it('reads do not allocate a bucket for a user who has never chatted', () => {
    store.findById('ghost', 'nope');
    store.list('ghost');
    // The previous `own()` inserted on read, so every GET leaked a Map entry.
    expect(store.userCount()).toBe(0);
  });

  it('sweeps conversations idle past the TTL', () => {
    store.create('u1');
    expect(store.userCount()).toBe(1);
    store.sweep(Date.now() + CHAT_TTL_MS + 1);
    expect(store.userCount()).toBe(0);
  });

  it('maybeSweep runs at most once per interval', () => {
    store.create('u1');
    const past = Date.now() + CHAT_TTL_MS + 1;

    // First call sweeps; a second call moments later must not re-walk the map.
    store.maybeSweep(past);
    expect(store.userCount()).toBe(0);

    store.create('u2');
    store.maybeSweep(past + SWEEP_INTERVAL_MS - 1);
    expect(store.userCount()).toBe(1);

    store.maybeSweep(past + SWEEP_INTERVAL_MS + CHAT_TTL_MS);
    expect(store.userCount()).toBe(0);
  });
});
