const path = require("path");
const axios = require("axios");
const cheerio = require("cheerio");
const fs = require("fs");

const TIME_OUT = 20 * 1000;
const REY_TIMES = 5;

const downloadsDir = path.join(__dirname, "downloads");
if (!fs.existsSync(downloadsDir)) {
  fs.mkdirSync(downloadsDir);
}

// 创建一个全局的错误收集对象
let globalErrors = {
  timestamp: new Date().toISOString(),
  sites: {},
};

const crawlGet = async ({ url = "" }) => {
  try {
    if (!url) {
      return new Error("URL is required");
    }

    const urlObj = new URL(url);
    const shouldCrawlEntireSite =
      urlObj.pathname === "/" || urlObj.pathname === "";

    const urlHost = urlObj.host;
    const urlHostArr = urlHost.split(".");
    let domain = urlHostArr.slice(-2);
    domain = domain.join(".");

    // 验证URL格式
    let baseUrl;
    try {
      baseUrl = urlObj.origin;
    } catch (error) {
      return new Error("Invalid URL format");
    }

    console.log("Starting crawl from:", url);
    console.log(
      "Crawl mode:",
      shouldCrawlEntireSite ? "Entire site" : "Single page"
    );

    // 规范化URL，移除多余的斜杠、锚点和查询参数
    function normalizeUrl(url) {
      try {
        const urlObj = new URL(url);
        // 移除末尾斜杠
        let path = urlObj.pathname.replace(/\/+$/, "");
        // 如果路径为空，添加单个斜杠
        if (!path) {
          path = "/";
        }
        // 返回规范化的URL，不包含锚点和查询参数
        return `${urlObj.protocol}//${urlObj.host}${path}`;
      } catch (e) {
        return url;
      }
    }

    // 存储已访问的URL和找到的链接
    const visitedUrls = new Set();
    const results = new Map(); // URL -> { links: [], linkStatus: Map }
    const urlsToVisit = [url];
    const crawlErrors = new Map(); // URL -> Error Message
    const resourceErrors = new Map(); // Resource URL -> { type: string, pageUrl: string, error: string }
    const seoErrors = new Map(); // URL -> SEO related errors
    let totalPages = 0;

    // 检查资源是否可访问
    async function checkResource(resourceUrl, type, pageUrl) {
      // 跳过包含 npm/eruda 的资源
      if (resourceUrl.toLowerCase().includes("npm/eruda")) {
        return true;
      }

      try {
        await axios({
          method: "head",
          url: resourceUrl,
          timeout: TIME_OUT,
          maxRedirects: REY_TIMES,
          validateStatus: function (status) {
            return status < 400;
          },
        });
        return true;
      } catch (error) {
        const errorMessage = `${error.message} (from page: ${pageUrl})`;
        resourceErrors.set(resourceUrl, { type, pageUrl, error: errorMessage });
        return false;
      }
    }

    // 检查链接是否可访问
    async function checkLink(href) {
      try {
        await axios({
          method: "head",
          url: href,
          timeout: TIME_OUT,
          maxRedirects: REY_TIMES,
          validateStatus: function (status) {
            return status < 400;
          },
        });
        return true;
      } catch (error) {
        return false;
      }
    }

    // 检查 hreflang 和 canonical 标签
    function checkSeoTags($, pageUrl) {
      const errors = [];

      // 获取所有标签
      const hreflangs = $('link[rel="alternate"][hreflang]');
      const canonical = $('link[rel="canonical"]');

      // 检查标签总数
      const totalTags = canonical.length + hreflangs.length;
      if (totalTags === 2 || totalTags === 3) {
        errors.push(
          `Invalid total number of link tags (canonical + alternate): ${totalTags}`
        );
      }

      // 检查 canonical 标签
      if (canonical.length === 0) {
        errors.push("Missing canonical tag");
      } else if (canonical.length > 1) {
        errors.push("Multiple canonical tags found");
      } else {
        const canonicalHref = canonical.attr("href");
        if (!canonicalHref) {
          errors.push("Canonical tag has no href attribute");
        } else if (!canonicalHref.startsWith("http")) {
          errors.push(`Invalid canonical URL format: ${canonicalHref}`);
        } else {
          // 规范化 URL，移除末尾的斜杠和 index.html
          const normalizePathUrl = (url) => {
            return url
              .replace(/\/$/, "") // 移除末尾斜杠
              .replace(/\/index\.html$/, "") // 移除末尾的 index.html
              .replace(/\/index$/, ""); // 移除末尾的 index
          };

          const normalizedCanonical = normalizePathUrl(canonicalHref);
          const normalizedPageUrl = normalizePathUrl(pageUrl);

          if (normalizedCanonical !== normalizedPageUrl) {
            // 如果不完全匹配，检查是否是因为 www 前缀的差异
            const canonicalDomain = new URL(normalizedCanonical).hostname;
            const pageDomain = new URL(normalizedPageUrl).hostname;

            // 如果域名不同，且不是仅仅是 www 前缀的差异，才报告错误
            if (canonicalDomain !== pageDomain) {
              const canonicalWithoutWww = canonicalDomain.replace(/^www\./, "");
              const pageWithoutWww = pageDomain.replace(/^www\./, "");
              if (canonicalWithoutWww !== pageWithoutWww) {
                errors.push(
                  `Canonical URL (${canonicalHref}) does not match page URL (${pageUrl})`
                );
              }
            }
          }
        }
      }

      // 如果有 alternate 标签，检查是否存在 x-default
      if (hreflangs.length > 0) {
        let hasXDefault = false;
        const hreflangMap = new Map();

        // 检查 URL 与语言代码的匹配
        function validateUrlLanguage(href, lang) {
          try {
            const url = new URL(href);
            const subdomain = url.hostname.split(".")[0];

            // en 和 x-default 都应该使用 www 子域名
            if (lang === "x-default" || lang === "en") {
              if (subdomain !== "www") {
                return `${lang} hreflang should use www subdomain, got: ${subdomain}`;
              }
              return null;
            }

            // 特殊语言代码匹配规则
            if (lang === "ja" && subdomain !== "jp") {
              return `Language code ${lang} should use jp subdomain, got: ${subdomain}`;
            }

            if (lang === "ko" && !["ko", "kr"].includes(subdomain)) {
              return `Language code ${lang} should use ko or kr subdomain, got: ${subdomain}`;
            }

            if (
              (lang === "zh-TW" || lang === "zh-Hant") &&
              subdomain !== "tw"
            ) {
              return `Language code ${lang} should use tw subdomain, got: ${subdomain}`;
            }

            // 一般情况：子域名应该与语言代码匹配
            if (
              !["ja", "ko", "zh-TW", "zh-Hant"].includes(lang) &&
              subdomain !== lang
            ) {
              return `Language code ${lang} does not match subdomain ${subdomain}`;
            }

            return null;
          } catch (error) {
            return `Invalid URL format: ${href}`;
          }
        }

        hreflangs.each((_, el) => {
          const $el = $(el);
          const lang = $el.attr("hreflang");
          const href = $el.attr("href");

          if (!href) {
            errors.push(
              `Hreflang tag missing href attribute for lang: ${lang}`
            );
            return;
          }

          // 跳过 mailto 链接
          if (href.toLowerCase().startsWith("mailto:")) {
            return;
          }

          if (!href.startsWith("http")) {
            errors.push(
              `Invalid hreflang URL format for lang ${lang}: ${href}`
            );
            return;
          }

          // 检查 URL 与语言的匹配
          const urlError = validateUrlLanguage(href, lang);
          if (urlError) {
            errors.push(urlError);
          }

          if (lang === "x-default") {
            hasXDefault = true;
          }

          if (hreflangMap.has(lang)) {
            errors.push(`Duplicate hreflang found for language: ${lang}`);
          }
          hreflangMap.set(lang, href);
        });

        // 如果有 alternate 标签但没有 x-default，报错
        if (!hasXDefault) {
          errors.push(
            "Alternate tags present but missing required x-default hreflang tag"
          );
        }
      }

      if (errors.length > 0) {
        seoErrors.set(pageUrl, errors);
      }
    }

    // 递归爬取函数
    async function crawlPage(pageUrl) {
      // 跳过包含 mailto 的 URL
      if (pageUrl.toLowerCase().includes("mailto")) {
        return;
      }

      // 规范化URL，移除查询参数
      const urlObj = new URL(pageUrl);
      pageUrl = `${urlObj.protocol}//${urlObj.host}${urlObj.pathname}`;
      const normalizedUrl = normalizeUrl(pageUrl);

      // Skip URLs containing 'blog'
      if (normalizedUrl.toLowerCase().includes("blog")) {
        return;
      }

      // 检查规范化后的URL是否已访问
      if (visitedUrls.has(normalizedUrl)) {
        // console.log(
        //   `Skipping duplicate page: ${pageUrl} (normalized: ${normalizedUrl})`
        // );
        return;
      }

      // 如果不是整站爬取模式，且不是初始URL，则跳过
      if (!shouldCrawlEntireSite && normalizedUrl !== normalizeUrl(url)) {
        console.log(`Skipping page: ${pageUrl} (not in single-page mode)`);
        return;
      }

      console.log("Crawling:", normalizedUrl);

      try {
        const response = await axios({
          method: "get",
          url: pageUrl,
          headers: {
            "User-Agent":
              "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
          },
          responseType: "text",
          timeout: 10000,
          maxRedirects: 0, // Prevent automatic redirects
          validateStatus: (status) => status < 400, // Accept 3xx status codes
        });

        // Skip pages with 301 or 302 redirects
        if (response.status === 301 || response.status === 302) {
          console.log(
            `Skipping redirected page: ${pageUrl} (${response.status})`
          );
          return;
        }

        visitedUrls.add(normalizedUrl);
        totalPages++;

        const $ = cheerio.load(response.data);

        // 检查 SEO 标签
        checkSeoTags($, pageUrl);

        const links = [];
        const linkStatus = new Map();
        const resources = new Set();

        // 检查所有资源链接
        const resourceSelectors = {
          css: 'link[rel="stylesheet"]',
          script: "script[src]",
          image: "img[src]",
          video: "video source[src]",
          audio: "audio source[src]",
          favicon: 'link[rel="icon"], link[rel="shortcut icon"]',
          font: 'link[rel="preload"][as="font"]',
        };

        // 收集所有资源URL
        for (const [type, selector] of Object.entries(resourceSelectors)) {
          $(selector).each((i, el) => {
            const src = $(el).attr("src") || $(el).attr("href");
            if (src) {
              try {
                const absoluteUrl = new URL(src, pageUrl).href;
                // 跳过包含 npm/eruda 的资源
                if (!absoluteUrl.toLowerCase().includes("npm/eruda")) {
                  resources.add({ url: absoluteUrl, type });
                }
              } catch (e) {
                // 忽略无效的URL
              }
            }
          });
        }

        // 检查link标签
        const linkElements = $("link").filter((i, el) => {
          const $link = $(el);
          return (
            ($link.attr("rel") && $link.attr("hreflang")) ||
            ($link.attr("rel") || "").trim() === "canonical"
          );
        });

        await Promise.all([
          // 检查link标签
          ...linkElements.map(async (i, element) => {
            const $link = $(element);
            const linkHtml = $.html(element).trim();
            const href = $link.attr("href");

            links.push(linkHtml);
            linkStatus.set(linkHtml, await checkLink(href));
          }),
          // 检查资源
          ...[...resources].map(async ({ url, type }) => {
            await checkResource(url, type, pageUrl);
          }),
        ]);

        if (links.length > 0) {
          results.set(pageUrl, { links, linkStatus });
        }

        const internalLinks = new Set();
        $("a[href]").each((index, element) => {
          const href = $(element).attr("href");
          try {
            // 跳过包含 mailto 的链接
            if (href.toLowerCase().includes("mailto")) {
              return;
            }

            const absoluteUrl = new URL(href, pageUrl).href;
            if (
              absoluteUrl.startsWith(baseUrl) &&
              !visitedUrls.has(absoluteUrl)
            ) {
              internalLinks.add(absoluteUrl);
            }
          } catch (e) {
            // 忽略无效的URL
          }
        });

        for (const link of internalLinks) {
          if (!visitedUrls.has(link)) {
            urlsToVisit.push(link);
          }
        }
      } catch (error) {
        crawlErrors.set(pageUrl, error.message);
      }
    }

    // 开始爬取过程
    const maxPages = 1000;
    while (urlsToVisit.length > 0 && totalPages < maxPages) {
      const nextUrl = urlsToVisit.shift();
      await crawlPage(nextUrl);
    }

    // 生成报告
    const generateReport = () => {
      // 如果没有错误，直接返回
      if (
        crawlErrors.size === 0 &&
        resourceErrors.size === 0 &&
        seoErrors.size === 0
      ) {
        console.log(`No errors found for site: ${url}`);
        return;
      }

      // 将当前站点的错误添加到全局错误对象中
      globalErrors.sites[url] = {
        totalPages: visitedUrls.size,
        errors: {
          crawlErrors: Array.from(crawlErrors.entries()).map(
            ([url, error]) => ({
              url,
              error,
            })
          ),
          resourceErrors: Array.from(resourceErrors.entries()).map(
            ([url, { type, pageUrl, error }]) => ({
              url,
              type,
              pageUrl,
              error,
            })
          ),
          seoErrors: Array.from(seoErrors.entries()).map(([url, errors]) => ({
            url,
            errors,
          })),
        },
      };
    };

    await generateReport();

    return {
      url: url,
      visitedUrls: Array.from(visitedUrls),
      results: Array.from(results.entries()).map(([pageUrl, { links }]) => ({
        pageUrl,
        links,
      })),
    };
  } catch (error) {
    return {
      url: url,
      error: error.message,
    };
  }
};

const lans1 = ["www", "es", "fr", "pt", "jp", "ar", "it", "ko", "tw", "de"];

let vidquLans = lans1.map((item) => {
  return `https://${item}.vidqu.ai/`;
});

let mioLans = lans1.map((item) => {
  return `https://${item === "ko" ? "kr" : item}.miocreate.com/`;
});

let vidwudLans = lans1.map((item) => {
  return `https://${item === "ko" ? "kr" : item}.vidwud.com/`;
});

let ismarttaLans = ["www", "es", "jp"].map((item) => {
  return `https://${item === "ko" ? "kr" : item}.ismartta.com/`;
});

let vidmudLans = lans1.map((item) => {
  return `https://${item === "ko" ? "kr" : item}.vidmud.com/`;
});

const urls = [
  ...vidquLans,
  ...mioLans,
  ...vidwudLans,
  ...ismarttaLans,
  ...vidmudLans,
  "https://www.vidwuz.com/",
  // "https://www.easehow.com/",
];

const folderPath = "downloads";
if (fs.existsSync(folderPath)) {
  fs.readdirSync(folderPath).forEach((file) => {
    const filePath = path.join(folderPath, file);
    fs.unlinkSync(filePath);
  });
}

const handle = async () => {
  console.log("urls", urls.length);
  // 清空旧的错误报告
  globalErrors = {
    timestamp: new Date().toISOString(),
    sites: {},
  };

  // 串行处理每个URL
  for (const url of urls) {
    console.log(`\nProcessing site: ${url}`);
    await crawlGet({ url });
  }

  // 在所有站点处理完成后，如果有错误则生成汇总报告
  if (Object.keys(globalErrors.sites).length > 0) {
    const reportFileName = `crawl-report-${new Date()
      .toISOString()
      .replace(/[:.]/g, "-")}.json`;
    const reportPath = path.join(downloadsDir, reportFileName);
    fs.writeFileSync(reportPath, JSON.stringify(globalErrors, null, 2));
    console.log(`\nError report generated: ${reportPath}`);
  } else {
    console.log("\nNo errors found for any site. No report generated.");
  }
};

handle();
