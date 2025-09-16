# Amazon Product Scraper

This is an Apify Actor that scrapes Amazon search results or product detail pages.

Features
- `search` mode: provide `keywords` (array) and `maxPagesPerKeyword` to scrape search results.
- `product_urls` mode: provide `productUrls` (array) to scrape product detail pages.
- Outputs results to the default Apify dataset (downloadable as CSV/JSON).

Notes
- Use Apify Proxy or other residential proxies for reliable scraping.
- Test with small inputs first (maxPagesPerKeyword: 1).
- Respect website terms of service and local laws.

See `INPUT_SCHEMA.json` for input fields and examples.
