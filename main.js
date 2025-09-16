'use strict';

const Apify = require('apify');
const { log } = Apify.utils;

Apify.main(async () => {
    const input = await Apify.getInput() || {};
    const mode = input.mode || 'search';
    const marketplace = input.marketplace || 'com';
    const keywords = input.keywords || [];
    const productUrls = input.productUrls || [];
    const maxPagesPerKeyword = input.maxPagesPerKeyword || 1;
    const concurrency = input.concurrency || 5;
    const runName = input.runName || 'amazon-scrape';

    log.info('Starting Amazon Product Scraper', { mode, marketplace });

    // Helper: build search URL for a keyword and page
    const buildSearchUrl = (keyword, page) => {
        const base = `https://www.amazon.${marketplace}/s`;
        const params = new URLSearchParams({ k: keyword, page: String(page) });
        return `${base}?${params.toString()}`;
    };

    // Prepare sources
    const sources = [];
    if (mode === 'search') {
        if (!Array.isArray(keywords) || keywords.length === 0) {
            throw new Error('In search mode you must provide keywords array in input.');
        }
        for (const kw of keywords) {
            for (let p = 1; p <= Math.max(1, maxPagesPerKeyword); p++) {
                sources.push({ url: buildSearchUrl(kw, p), userData: { type: 'search', keyword: kw, page: p } });
            }
        }
    } else if (mode === 'product_urls') {
        if (!Array.isArray(productUrls) || productUrls.length === 0) {
            throw new Error('In product_urls mode you must provide productUrls array.');
        }
        for (const u of productUrls) {
            sources.push({ url: u, userData: { type: 'product' } });
        }
    } else {
        throw new Error('Unknown mode: ' + mode);
    }

    const requestList = new Apify.RequestList({ sources });
    await requestList.initialize();

    const dataset = await Apify.openDataset();

    const crawler = new Apify.PuppeteerCrawler({
        requestList,
        maxConcurrency: concurrency,
        launchPuppeteerOptions: {
            headless: true,
        },
        handlePageTimeoutSecs: 120,

        handlePageFunction: async ({ page, request }) => {
            const { url } = request;
            const { type } = request.userData || {};
            log.info('Processing', { url, type });

            try {
                if (type === 'search') {
                    // Wait a little for results to load
                    await page.waitForSelector('div.s-result-item', { timeout: 7000 }).catch(() => {});

                    const items = await page.$$eval('div.s-result-item[data-asin]', (nodes) => {
                        return nodes.map(n => {
                            const asin = n.getAttribute('data-asin') || null;
                            const titleNode = n.querySelector('h2 a span');
                            const title = titleNode ? titleNode.innerText.trim() : null;
                            const urlNode = n.querySelector('h2 a');
                            const url = urlNode ? urlNode.href.split('?')[0] : null;

                            // Price can be in different spots
                            const priceWhole = n.querySelector('.a-price .a-price-whole');
                            const priceFraction = n.querySelector('.a-price .a-price-fraction');
                            let price = null;
                            if (priceWhole) {
                                price = priceWhole.innerText.replace(/[^0-9.,]/g, '');
                                if (priceFraction) price += '.' + priceFraction.innerText.replace(/[^0-9]/g, '');
                            }

                            const ratingNode = n.querySelector('.a-icon-alt');
                            const rating = ratingNode ? ratingNode.innerText.split(' ')[0] : null;

                            const reviewsNode = n.querySelector('.a-size-base');
                            const reviews = reviewsNode ? reviewsNode.innerText.replace(/[^0-9]/g, '') : null;

                            return { asin, title, url, price, rating, reviews };
                        }).filter(x => x.asin || x.title);
                    });

                    for (const it of items) {
                        const out = {
                            type: 'search_result',
                            keyword: request.userData.keyword,
                            page: request.userData.page,
                            scrapedAt: new Date().toISOString(),
                            marketplace,
                            ...it,
                        };
                        await dataset.pushData(out);
                    }

                } else if (type === 'product') {
                    // Product detail page
                    await page.waitForSelector('#productTitle, #title', { timeout: 8000 }).catch(() => {});

                    const result = await page.evaluate(() => {
                        const getText = (sel) => {
                            const el = document.querySelector(sel);
                            return el ? el.innerText.trim() : null;
                        };

                        const title = getText('#productTitle') || getText('#title');

                        // Price: variety of selectors
                        const priceSelectors = ['#priceblock_ourprice', '#priceblock_dealprice', '#price_inside_buybox', '.a-price .a-offscreen'];
                        let price = null;
                        for (const s of priceSelectors) {
                            const p = document.querySelector(s);
                            if (p) { price = p.innerText.replace(/[^0-9.,]/g, ''); break; }
                        }

                        const ratingNode = document.querySelector('[data-hook=rating-out-of-text], .a-icon-alt');
                        const rating = ratingNode ? ratingNode.innerText.split(' ')[0] : null;
                        const reviewsNode = document.querySelector('#acrCustomerReviewText');
                        const reviews = reviewsNode ? reviewsNode.innerText.replace(/[^0-9]/g, '') : null;

                        const availability = getText('#availability') || getText('#availability_feature_div');

                        const canonical = (document.querySelector('link[rel=canonical]') || {}).href || location.href;

                        let asin = null;
                        const urlMatch = location.pathname.match(/\/([dg]p|product)\/(?:product|)([A-Z0-9]{10})/i);
                        if (urlMatch && urlMatch[2]) asin = urlMatch[2];

                        const metaAsin = document.querySelector('meta[name="asin"]');
                        if (!asin && metaAsin) asin = metaAsin.getAttribute('content');

                        return { title, price, rating, reviews, availability, canonical, asin };
                    });

                    const out = {
                        type: 'product_page',
                        scrapedAt: new Date().toISOString(),
                        marketplace,
                        url,
                        ...result,
                    };
                    await dataset.pushData(out);
                }

            } catch (err) {
                log.warning('Error while processing page', { url, err: err.message });
                await dataset.pushData({ type: 'error', url, error: err.message, scrapedAt: new Date().toISOString() });
            }
        },

        handleFailedRequestFunction: async ({ request }) => {
            log.error('Request failed too many times', { url: request.url });
            const failedDataset = await Apify.openDataset('FAILED_REQUESTS');
            await failedDataset.pushData({ url: request.url, error: request.errorMessages, timestamp: new Date().toISOString() });
        }
    });

    // Run crawler
    await crawler.run();

    log.info('Crawl finished');

});
