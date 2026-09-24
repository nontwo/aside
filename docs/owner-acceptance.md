# Owner acceptance — native temporary-chat handoff

What this build does automatically, and what only you do:

| Aside does | You do |
| --- | --- |
| Shows the Aside toolbar when you select text in an answer | Choose **Ask**, **Why** or **New-tab** |
| Prepares one readable prompt: the passage (formulas as their TeX source), its paragraph or block, the question before it, definitions it can see, and anything you add — the full prompt is visible before you copy | Type or edit the question, and remove or add context if you want |
| On **Copy & open temporary chat**: copies exactly the previewed prompt, then opens a new ChatGPT/Claude window (New-tab: a tab) | Check the native page is in Temporary / Incognito mode, choose Personalized/Unpersonalized and a model if you want, paste, and send |
| Nothing in the native page: no clicks, no typing, no paste, no send, no reading the answer back | Read the answer and ask follow-ups there |
| Returns you to the passage (the card's **Jump to passage**, or the toolbar popup's **Return to source**) | Keep reading |
| On **End & discard**: clears the question from Aside; closes the tab it opened while that tab is still provably its own (after telling you) | Decide when a question is done; close the native tab yourself when Aside says it will stay open |
| On **Save local note…**: saves the passage, question and your note as a permanent library record — only then | Decide what is worth keeping |

Everything is offline-verified against fixtures unless marked **live**. Live
checks on your signed-in accounts are the part only you can do.

## Load / update the build

1. Put the new build's files in the directory Aside is already loaded from
   (the staged acceptance directory), then `chrome://extensions/` → Developer
   Mode → press **Reload** on the Aside card. Do not remove the extension — that
   would delete its saved data. Restarting the browser alone is not enough: a
   same-version unpacked extension can keep its previous service worker until
   it is reloaded.
2. Reload makes Chrome clear session storage, so any temporary handoff or
   private branch that is open at that moment is dropped. End or note what you
   need first.
3. Hard-reload open `chatgpt.com` and `claude.ai` tabs (content scripts are
   injected on page load).
4. Click the Aside toolbar icon: the popup lists active temporary handoffs and
   shows `Aside build <id>` at the bottom. Compare it with the PR head. The
   library (popup → **Open library**) shows the same build id.

## Walkthrough (**live**, once per provider)

For ChatGPT, then Claude:

1. Open a conversation with a mathematical answer. Select part of a formula and
   the sentence around it.
2. Choose **Why** (or **Ask** and type a question). The card says
   `Temporary handoff · Not saved in Aside`. The selected passage shows the
   formula as TeX (for example `$S_2 \ne S^2$`), not as `S2≠S2`.
3. Open **Edit context and see the full prompt**: the passage, its paragraph,
   the question before it, and — when you selected only part of a formula — the
   whole equation labelled as context. Missing material is listed as missing.
4. Press **Copy & open temporary chat**. The card reports the copy and the
   opening separately. A new window opens:
   - ChatGPT: `chatgpt.com/?temporary-chat=true`. Check that Temporary is
     selected (select it if not); if asked, choose Unpersonalized for a
     context-isolated answer.
   - Claude: `claude.ai/new`. Start Incognito with the ghost icon (outside any
     Project); the chat shows an "Incognito chat" label.
5. Choose a model there if you want, paste (⌘V / Ctrl+V), check the pasted text,
   and send. Ask one follow-up in the same native chat.
6. Back on the source tab (or popup → **Return to source**), the passage is
   highlighted where you left it; the conversation has not changed.
7. **End & discard** → read the confirmation. If the native page still shows the
   new chat Aside opened, the tab closes; if ChatGPT/Claude has moved the chat to
   its own conversation address, Aside cannot prove the tab is still its own and
   says the tab will stay open — close it yourself. Either way the card is gone.
8. Popup: no active handoffs. Library: no new record for this question.

Also check once:

- **Hide** (or Escape inside the card) puts it in the left rail as `temporary`;
  clicking the rail entry brings it back. Escape elsewhere is the provider's.
- **Save local note…** shows exactly what will be saved and says it is a
  permanent local record; after **Save to library** it appears in the library.
- Closing the native tab yourself clears that question from Aside.
- Closing the source tab leaves the native chat open; the popup still offers
  **End & discard**.
- Existing saved questions are still in the library (search, view, resolve,
  export, backup). A saved branch on its source page is read-only: **Open
  conversation** opens the saved chat; **Ask about this passage** starts a new
  temporary handoff and leaves the record as it was.

## What is not claimed

- Aside does not see or verify the native Temporary/Incognito mode; the native
  page and your check before pasting are the safeguard. A missing observation is
  expected, not a defect.
- `chatgpt.com/?temporary-chat=true` is an observed entry, not an API; if it
  lands on a normal chat, a sign-in or a choice screen, select Temporary there.
- Claude's `incognito` URL shortcut is not used (unverified); the base
  `claude.ai/new` page is the route.
- The clipboard keeps the prompt until you copy something else. **More → Clear
  clipboard now** replaces it with empty text in this browser; clipboard history
  or synced clipboards may keep a copy.
- Provider retention is the provider's: ChatGPT may keep a temporary chat up to
  30 days for safety; Anthropic keeps Incognito chats 30 days by default. Saving
  a chat in the provider changes its lifecycle.

## Known limitations

- Aside does not capture new answers. To keep part of one, paste it into
  **Save local note…** yourself.
- A temporary handoff lives only for the browser session; a browser or extension
  restart clears it (by design, never restored from disk).
- Once a native tab shows any conversation address (the provider moving the
  temporary chat to its own URL, or you opening another chat there), Aside will
  focus it but not close it on End: from the URL alone the two cannot be told
  apart, and Aside never closes a tab it cannot prove it opened.
- The open card occupies the right of the page; it stops above the composer, but
  at narrow widths it can sit over reading text. Check that ChatGPT's/Claude's own
  selection popup is not left under the card on your screen (**Hide** or Escape
  frees the space).
