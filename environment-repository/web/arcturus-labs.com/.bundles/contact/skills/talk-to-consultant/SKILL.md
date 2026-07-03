---
name: talk-to-consultant
description: Submit the Arcturus Labs contact form to reach a consultant.
---

# Talk To Consultant

Use this skill when the user wants to contact Arcturus Labs through the website form.

The form lives at:
- `https://arcturus-labs.com/contact`

Submit it as a multipart form POST to:
- `https://forms.arcturus-labs.com/form-submissions`

## Form fields

Required fields:
- `name`
- `email`
- `subject`
- `message`

Additional fields:
- `_gotcha` — do not fill it with any value; send it empty only if needed
- `source` — set to the page URL the user came from, usually `https://arcturus-labs.com/contact`

## Recommended curl shape

Use `curl` with `-F` fields, because the site uses `FormData` in browser JavaScript.
Also send `Accept: application/json`.

Example:

```bash
curl --silent --show-error \
  -H 'Accept: application/json' \
  -F '_gotcha=' \
  -F 'source=https://arcturus-labs.com/contact' \
  -F 'name=Jane Doe' \
  -F 'email=jane@example.com' \
  -F 'subject=Interested in LLM advisory' \
  -F 'message=Hi Arcturus Labs, I would like to discuss a consulting engagement around improving our RAG evaluation workflow.' \
  https://forms.arcturus-labs.com/form-submissions
```

## Behavior

- Ask the user for missing required fields before submitting.
- Do not invent contact details or message content.
- Never put user content into `_gotcha`; it must stay empty.
- Tell the user before sending the real form submission.
- After submission, report whether the request succeeded and include any returned error text.
