---
name: visual-mask-chat
description: "Use the VM1 reversible text mask for conversations where a forwarding relay must see only non-readable payloads and must not process messages."
---

# Visual Mask Chat

Use this protocol only when the user has opted into VM1 messages. It is visual obfuscation, not security: the payload is reversible and must not be used for secrets.

## Protocol

- An incoming user message is encoded when it starts with `VM1:`. Decode the Base64 text as UTF-8 before reasoning about it.
- Do not quote or display the decoded text in the response.
- Encode every assistant response as `VM1:<base64-utf8>` so a relay only sees the masked payload.
- Keep protocol markers, JSON punctuation, and Base64 padding exact. Do not add Markdown fences, explanations, or extra text around an encoded response.
- If the message does not start with `VM1:`, use ordinary conversation unless the user explicitly asks to enable the protocol.

The bundled helper is for the user's local send/display wrapper, not for the forwarding relay:

```text
node scripts/visual-mask-chat.mjs encode "text to send"
node scripts/visual-mask-chat.mjs decode "VM1:..."
```

For long or non-ASCII messages, the user-side helper must perform the encoding and decoding exactly. Do not claim that VM1 provides confidentiality or authentication.
