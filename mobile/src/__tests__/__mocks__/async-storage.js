// Mock for @react-native-async-storage/async-storage
const store = {};

const AsyncStorage = {
  getItem: jest.fn(async (key) => store[key] ?? null),
  setItem: jest.fn(async (key, value) => { store[key] = value; }),
  removeItem: jest.fn(async (key) => { delete store[key]; }),
  clear: jest.fn(async () => { Object.keys(store).forEach(k => delete store[k]); }),
  _store: store,
  _reset: () => { Object.keys(store).forEach(k => delete store[k]); },
};

module.exports = AsyncStorage;
