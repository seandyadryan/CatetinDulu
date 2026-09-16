# Deployment verification — 16 September 2026

- Six offline unit tests passed: parser boundaries, semantic clarification, immutable edit fields, inbound filtering, webhook contract, sender queue.
- Twelve Indonesian examples parsed using the live Groq API (model `openai/gpt-oss-120b`, selected from the account's available models).
- Database integration tests passed in `catetindulu_test`: balanced transfers, update/delete ledger consistency, cross-user isolation, duplicate protection, pending context, filtered report, processing lease/retry, and SQL-injection-shaped descriptions treated only as data.
- Full authenticated n8n webhook integration passed in the isolated database: income → duplicate → transfer → missing electricity amount → continuation → edit → expense report → balance → delete → monthly report.
- Expected test balance after income 8,000,000, internal transfer 500,000, and expense edited to 300,000: total 7,700,000. After deleting the expense: total 8,000,000; expense report 0.
- Public HTTPS page and status endpoint tested; admin status requires authentication. WhatsApp QR produced. Sending/receiving through an actual linked WhatsApp account still requires the owner to scan QR and send a real message.
- Production stores no seeded users/transactions. Test fixtures live only in the separate test database, with the test workflow unpublished after verification.
- Exact live text regression `beli nasi padang di shopeefood 45.820` parsed as expense amount 45820, category food, with ShopeeFood kept as merchant context rather than an account.
- Receipt image path validates MIME/signature/size, strips image bytes before PostgreSQL, and sends the image only to Groq's vision model. The final amount rule is documented in `prompts/receipt.txt`.
- Navicat connection configuration created with SSH tunneling. Database connectivity tested through the same SSH endpoint; opening the Navicat UI still requires the database password from the private access note.

## Known dependency constraints

The upstream whatsapp-web.js 1.34.7 pins Puppeteer 24.38.0. `npm audit --omit=dev` reports five high-severity entries in its dependency chain, rooted in `extract-zip` archive extraction (GHSA-jmr9-qjv8-65gv / GHSA-7pqw-9j4j-h8q3). This deployment disables Puppeteer's browser downloads and uses distro Chromium; it does not extract user archives. Do not enable browser downloads or archive-processing paths without resolving this upstream dependency. A forced downgrade/major Puppeteer override was not applied because it changes the WhatsApp gateway's supported dependency contract.

n8n 2.39.5 runs against PostgreSQL 16 in compatibility-support mode. Plan a separate tested database upgrade to PostgreSQL 17+ for n8n's full support range. n8n's Python runner is unused; all workflow Code nodes are JavaScript.
