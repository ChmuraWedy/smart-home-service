# Continue development on another Mac

The repository contains source code and examples; runtime secrets and databases are kept separately. A new checkout alone does not restore the home's credentials or history.

1. Clone the repository and select the required branch.
2. Create a Python virtual environment and install `.[cloud,dev]` as described in the [quick start](../README.md#development).
3. Install the frontend's declared Node.js/pnpm versions, install its locked dependencies, and start the frontend separately from the API.
4. Transfer private settings, a consistent SQLite backup, and Tuya session files through a private channel only when that machine should use the same deployment. Preserve private file permissions and keep those files ignored by Git.
5. Export the standalone API's environment settings. Update browser API URL/key and CORS origins for the new computer. A browser's localhost address refers to that computer, not the old server.
6. Verify health and authorized inventory before using device controls. Select the new machine's real LAN interface for discovery; old addresses can be stale.

Use one active service instance/worker for local command locking. Do not run two collectors against shared runtime files or copy a live SQLite file inconsistently. Use SQLite backup or stop the source service. Do not overwrite a working target database with an example import.

A transferred confirmed Sharing session can survive restart; changing a browser origin requires saving its service access key again. Developer credentials and a validated in-memory connection are separate. Device local keys stay server-side. [Deployment](../deploy/docker.md) explains the Docker/Dell path and per-deployment key rotation.
