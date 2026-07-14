# Provenance

CueLine is a new implementation combining two ideas behind one public API:

- A deterministic lane router inspired by Omnilane's candidate chains and pre-spawn availability checks.
- A text-only ChatGPT web controller adapter informed by GPT Relay's observed browser behavior.

No CueLine runtime module imports either project. No browser cookies, local credentials, provider sessions, or machine-specific state are included in this repository.

The initial architecture was reviewed through a ChatGPT Pro conversation. That review recommended a TypeScript state-machine core, append-only events, deterministic identifiers, explicit controller envelopes, and no automatic worker fallback after execution starts.
