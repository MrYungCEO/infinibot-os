// Minimal react-native mock for jest (node environment)
const AppState = {
  currentState: 'active',
  addEventListener: jest.fn(() => ({ remove: jest.fn() })),
};

module.exports = {
  AppState,
  Platform: { OS: 'ios', select: (obj) => obj.ios || obj.default },
};
