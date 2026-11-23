- Switching provider in Home or the workflow Implement dialog now keeps the access mode when the
  new provider offers it, narrows it when it doesn't, and never widens it to Full access. When only
  wider modes remain, you pick one before starting.
- ACP providers (Grok and custom ACP agents included) now apply configuration changes the agent
  reports on its own, such as a model or mode it switched itself.
