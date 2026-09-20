# Notes for certification — Microsoft Edge Add-ons

Paste the section below into **Partner Center → Availability → Notes for
certification**. It answers the three things a reviewer needs: whether an
account is required, how to exercise every feature, and why each permission
is requested.

---

## Testing OpenCapture

**No account or sign-in is needed to test this extension.** Every capture,
editing and export feature works immediately after install, with no network
access of any kind. Please start there. One optional feature — the tiled
watermark — is a paid unlock, and a test account with it **already
unlocked** is supplied in this submission's test-account fields, so it can
be reviewed without any purchase. See the last section.

### What it does

OpenCapture takes a screenshot of a web page — the whole scrolling page, the
visible area, or a dragged region — then lets you crop, annotate, blur and
export it as PNG or PDF. The capture, the stitching, the editing and the
export all run locally in the browser. Nothing is uploaded.

### Testing it, start to finish (about three minutes)

1. **Install**, then open any long page — `https://en.wikipedia.org/wiki/Browser_extension`
   is a good one.
2. Click the OpenCapture toolbar icon and choose **Capture full page**. The
   page scrolls itself, then the editor opens in a new tab with the whole
   page as one image.
3. In the editor, try **Crop**, **Arrow**, **Box**, **Text** and **Blur** —
   click the tool, then drag on the image. **Undo** and **Redo** are in the
   toolbar.
4. Click **Save as PNG**. The file downloads. Click **Export as PDF** for the
   same image as a PDF.
5. Back on the page, use **Capture visible area** and **Capture selected
   area** (drag a rectangle) from the popup.
6. **History** (the clock icon in the popup) lists recent captures; they are
   stored locally in IndexedDB and can be reopened or deleted there.

Very long pages produce an image too large for one PNG. The popup then asks
how to keep it — PDF, several PNGs, or the editor — rather than choosing for
you. This is expected behaviour, not an error.

### Why each permission is requested

| Permission | Why |
|---|---|
| `activeTab` | Read the page being captured — only the tab the user invokes the extension on, only after they click. |
| `scripting` | Inject the content script that measures the page and scrolls it during a full-page capture. |
| `downloads` | Save the finished PNG or PDF to disk. |
| `storage` | Remember preferences (save folder, filename, language) and the local capture history. |

**No host permissions are requested at install.** The three hosts in
`optional_host_permissions` are requested only if the user chooses an
optional feature, and Edge prompts for each at that moment:

- `auth.opencapture.app`, `gateway.opencapture.app` — only if the user signs
  in for the paid watermark.
- `openpdfedit.com/app` — only if the user ticks "Open the PDF in
  OpenPdfEdit" and hands a finished PDF to that editor.

A reviewer who never signs in and never ticks that box will never see these
prompts, and the extension makes no network request at all.

### Data handling

No analytics, no telemetry, no tracking, no remote code. Captures never leave
the machine. The only network traffic the extension can make is to the
optional hosts above, and only after the user has granted them.

Privacy policy: https://opencapture.app/privacy.html

### The one paid feature

The **watermark** tool (editor toolbar) tiles a logo or text across the
image. It is a one-time unlock costing 1,000 credits, bought through the
user's account, and it is the only thing in the extension behind a sign-in.

Clicking it while signed out shows an explanatory panel and a **Sign in**
button — nothing is charged and nothing happens without an explicit further
click. That panel is the entire gated surface, and it is reviewable as-is.

**To exercise the watermark itself, a test account is supplied in this
submission's test-account fields.** It already holds the unlock, so no
purchase, payment or credit top-up is needed:

1. Click the OpenCapture toolbar icon, then **Sign in** (top right of the
   popup). A normal tab opens — a popup closes as soon as it loses focus and
   cannot host a sign-in redirect.
2. Choose **Continue with Google** and use the supplied credentials. Edge
   will ask once for permission to contact `auth.opencapture.app`; that
   prompt *is* the sign-in.
3. The popup's account button now shows a credit balance instead of
   "Sign in".
4. Capture any page, then open the editor and click the **watermark** tool.
   It opens straight into the watermark panel — the account already holds the
   unlock, so no payment prompt appears. Type any text to see it tiled
   across the capture.

The unlock is a permanent entitlement on that account rather than a
subscription or a balance, so it cannot lapse or be spent during review.

Sign-in also offers a crypto wallet and Nostr; both need a signer extension
the reviewer would have to install, so Google is the route to use.
