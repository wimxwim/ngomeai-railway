# User Profile Memory
Last Updated: 2026-05-07 19:33
Cron Job: Tim Hafal (The Vigilant Guardian) - 1 minute interval

## Local Wikipedia Status
- EN Filtered Wiki: /home/ngome/Data/wikipedia/enwiki-filtered/
  - Status: FAILED (0 articles, 0 GB)
  - Issue: All category downloads returned JSON parse errors (missing API error handling, no retries, improper user agent in requests)
  - Missing Info: English Wikipedia filtered articles for 20 technical categories (Cybersecurity, AI, ML, etc.)
- ID Wiki: /home/ngome/Data/wikipedia/idwiki/extracted/
  - Status: Raw dump present (idwiki-latest-pages-articles.xml, 5.6GB)
  - Issue: Unprocessed raw XML, no searchable text files
  - Missing Info: Extracted, filtered Indonesian Wikipedia articles

## Missing Info To Deepen
1. Fix download_en_filtered.py: Add API error handling, retries, proper user agent for requests, rate limit compliance
2. Process ID wiki XML dump: Extract articles, filter by relevant categories
3. Verify EN wiki category membership queries (fix MediaWiki API integration)

## Last Research Activity
- Research Topic: Local Wikipedia data integrity check
- Findings: EN filtered download failed, ID wiki raw dump exists, download scripts need debugging
- Action Items: Patch download_en_filtered.py, process ID wiki XML
