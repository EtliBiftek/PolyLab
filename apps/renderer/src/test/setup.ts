// React 18 act() support under vitest/jsdom.
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// jsdom does not implement scrollIntoView; MessageList autoscroll hits it.
Element.prototype.scrollIntoView = () => {};
