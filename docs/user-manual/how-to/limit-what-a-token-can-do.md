# Limit what a token can do

Use this when you give a token to an agent that should see or change only part of your knowledge.
Limits are set when you create the token and cannot be edited later; to change them, create a new
token and revoke the old one.

## Steps

1. Open **Settings → OKF Wiki** and go to **New token**.
2. Type the agent's name in **New token name**.
3. Optional: in **Limit to bundles**, list bundle folders separated by commas, for example
   `Knowledge, Projects`. Empty means all bundles.
4. Optional: in **Limit to paths**, list folders inside the bundles, for example
   `concepts, decisions`. Empty means everything.
5. Turn on only the scopes the agent needs. Every token can read.
   - **Scope: Write** for agents that draft notes.
   - **Scope: Publish**, **Scope: Replace raw sources** and **Scope: Edit computations** only for
     trusted automation.
6. If the token belongs to a script or service rather than an agent, turn on **Automated
   process**. Its writes are then stamped `process:<name>`.
7. Select **Create token** and copy what you need from the dialog.
8. Check the result under **Access tokens**: the new token's line shows its scopes, bundles and
   paths, for example `read, write · Knowledge; paths: concepts, decisions · created … · never used`.

To take access away, select **Revoke** next to the token under **Access tokens**. Agents using it
lose access at once.

## See also

- [Configuration](../reference/configuration.md#access-tokens): every token setting.
- [Trust and provenance](../concepts/trust-and-provenance.md): why publishing is for automation only.
