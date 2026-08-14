(function initOzonErpCollector(global) {
  if (global.OzonErpCollector?.version) return;

  const VERSION = '0.2.2';
  const SKU_RE = /(?:ozon\.(?:ru|kz|by))?\/product\/(?:[^/]+-)?(\d+)(?:\/|\?|$)/;
  const CURRENCY_SYMBOLS = {
    CNY: '¥',
    RUB: '₽',
    USD: '$',
    EUR: '€',
    BYN: 'Br',
    KZT: '₸'
  };

  function cleanText(value) {
    return String(value == null ? '' : value).replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
  }

  function extractOzonSku(url = global.location?.href || '') {
    const match = String(url || '').match(SKU_RE);
    return match ? match[1] : null;
  }

  function parseWidgetState(widgetStates, prefix) {
    const key = Object.keys(widgetStates || {}).find((name) => name.startsWith(prefix));
    if (!key) return null;
    const value = widgetStates[key];
    if (typeof value !== 'string') return value;
    try {
      return JSON.parse(value);
    } catch (error) {
      return null;
    }
  }

  function parseAllWidgetStates(widgetStates, prefix) {
    return Object.keys(widgetStates || {})
      .filter((name) => name.startsWith(prefix))
      .map((name) => {
        const value = widgetStates[name];
        if (typeof value !== 'string') return value;
        try {
          return JSON.parse(value);
        } catch (error) {
          return null;
        }
      })
      .filter(Boolean);
  }

  function hasUsableJsonContent(value) {
    if (value == null) return false;
    if (typeof value === 'string') return cleanText(value).length > 0;
    if (Array.isArray(value)) return value.length > 0;
    if (typeof value === 'object') return Object.keys(value).length > 0;
    return false;
  }

  function pickBestRichDescriptionWidget(widgetStates) {
    const descriptions = parseAllWidgetStates(widgetStates, 'webDescription-');
    if (!descriptions.length) return null;
    const withJson = descriptions.find((item) => hasUsableJsonContent(item?.richAnnotationJson));
    return withJson || descriptions[0] || null;
  }

  async function sleep(ms) {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }

  function normalizeHashtag(value) {
    const text = cleanText(value);
    if (!text) return '';
    return text.startsWith('#') ? text : `#${text}`;
  }

  function extractHashtagsFromWidget(value) {
    const badges = Array.isArray(value?.badges) ? value.badges : [];
    const tags = badges
      .map((badge) => normalizeHashtag(badge?.text || badge?.title || badge?.label || ''))
      .filter(Boolean);
    return Array.from(new Set(tags));
  }

  function mergeHashtags(...sources) {
    const tags = sources
      .flatMap((source) => (Array.isArray(source) ? source : []))
      .map(normalizeHashtag)
      .filter(Boolean);
    return Array.from(new Set(tags));
  }

  function parsePrice(value) {
    if (value == null || value === '') return null;
    const raw = String(value).replace(/[^\d,.]/g, '').replace(',', '.');
    const parsed = parseFloat(raw);
    return Number.isFinite(parsed) ? parsed : null;
  }

  function detectCurrency(value, fallback = 'CNY') {
    const symbol = String(value || '').match(/[^\d\s,.]+$/)?.[0];
    const entry = Object.entries(CURRENCY_SYMBOLS).find(([, item]) => item === symbol);
    return entry ? entry[0] : fallback;
  }

  function extractSeoPriceCurrency(page) {
    const scripts = Array.isArray(page?.seo?.script) ? page.seo.script : [];
    for (const item of scripts) {
      const text = item?.innerHTML;
      if (!text) continue;
      try {
        const parsed = JSON.parse(text);
        const offers = Array.isArray(parsed?.offers) ? parsed.offers[0] : parsed?.offers;
        const currency = offers?.priceCurrency || parsed?.priceCurrency;
        if (currency) return String(currency).trim().toUpperCase();
      } catch (error) {}
    }
    return '';
  }

  function pickTextLike(value) {
    if (value == null) return '';
    if (typeof value === 'string' || typeof value === 'number') return cleanText(value);
    if (Array.isArray(value)) return value.map(pickTextLike).filter(Boolean).join('/');
    if (typeof value !== 'object') return '';
    return cleanText(
      value.text ||
      value.title ||
      value.name ||
      value.label ||
      value.caption ||
      value.categoryName ||
      value.category_name ||
      value.path ||
      value.pathName ||
      ''
    );
  }

  function extractCategoryNamesFromNode(node, depth = 0, result = []) {
    if (!node || depth > 7 || result.length >= 8) return result;
    if (Array.isArray(node)) {
      node.forEach((item) => extractCategoryNamesFromNode(item, depth + 1, result));
      return result;
    }
    if (typeof node !== 'object') return result;
    const keys = ['breadcrumbs', 'breadcrumb', 'categoryPath', 'categories', 'category', 'catalogPath'];
    for (const key of keys) {
      const value = node[key];
      if (!value) continue;
      if (Array.isArray(value)) {
        value.forEach((item) => {
          const text = pickTextLike(item);
          if (text && !result.includes(text)) result.push(text);
        });
      } else {
        const text = pickTextLike(value);
        if (text && !result.includes(text)) result.push(text);
      }
    }
    for (const value of Object.values(node)) {
      if (value && typeof value === 'object') extractCategoryNamesFromNode(value, depth + 1, result);
    }
    return result;
  }

  function extractSeoCategoryPath(page) {
    const scripts = Array.isArray(page?.seo?.script) ? page.seo.script : [];
    for (const item of scripts) {
      const text = item?.innerHTML;
      if (!text) continue;
      try {
        const parsed = JSON.parse(text);
        const graphs = Array.isArray(parsed) ? parsed : [parsed, ...(Array.isArray(parsed?.['@graph']) ? parsed['@graph'] : [])];
        for (const graph of graphs) {
          const type = Array.isArray(graph?.['@type']) ? graph['@type'].join(' ') : String(graph?.['@type'] || '');
          if (!/BreadcrumbList/i.test(type)) continue;
          const names = (Array.isArray(graph.itemListElement) ? graph.itemListElement : [])
            .map((entry) => pickTextLike(entry?.item?.name || entry?.name || entry?.item))
            .filter(Boolean);
          if (names.length) return names.join('/');
        }
      } catch (error) {}
    }
    return '';
  }

  function extractCategoryMetaFromPage(page) {
    const names = extractCategoryNamesFromNode(page?.widgetStates || {});
    const widgetCategory = names.length ? names.join('/') : '';
    const seoCategory = extractSeoCategoryPath(page);
    const category = cleanText(widgetCategory || seoCategory);
    return {
      category,
      categoryName: category.split('/').filter(Boolean).pop() || category,
      category_path: category
    };
  }

  function cleanImageUrl(url) {
    return url ? String(url).replace(/\/wc\d+/g, '') : url;
  }

  function normalizeDecimal(value) {
    if (value == null || value === '') return null;
    const parsed = Number(String(value).replace(',', '.').replace(/[^\d.]/g, ''));
    return Number.isFinite(parsed) ? parsed : null;
  }

  function formatMeasurement(value) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return '';
    return Number.isInteger(numeric) ? String(numeric) : String(Math.round(numeric * 100) / 100);
  }

  function toMillimeters(value, unit = '') {
    const numeric = normalizeDecimal(value);
    if (numeric == null) return '';
    const normalizedUnit = String(unit || '').trim().toLowerCase();
    if (['см', 'cm'].includes(normalizedUnit)) return formatMeasurement(numeric * 10);
    if (['м', 'm'].includes(normalizedUnit)) return formatMeasurement(numeric * 1000);
    return formatMeasurement(numeric);
  }

  function toGrams(value, unit = '') {
    const numeric = normalizeDecimal(value);
    if (numeric == null) return '';
    const normalizedUnit = String(unit || '').trim().toLowerCase();
    if (['кг', 'kg'].includes(normalizedUnit)) return formatMeasurement(numeric * 1000);
    return formatMeasurement(numeric);
  }

  function parseDimensionText(text) {
    const source = cleanText(text).replace(/х/g, 'x').replace(/Х/g, 'x');
    if (!source) return null;
    const patterns = [
      /(?:размер(?:ы)?|габарит(?:ы)?|dimensions?|size|длина[^:：]{0,30}ширина[^:：]{0,30}высота)\D{0,80}(\d+(?:[,.]\d+)?)\s*[x×*]\s*(\d+(?:[,.]\d+)?)\s*[x×*]\s*(\d+(?:[,.]\d+)?)(?:\s*(мм|mm|см|cm|м|m))?/i,
      /(\d+(?:[,.]\d+)?)\s*[x×*]\s*(\d+(?:[,.]\d+)?)\s*[x×*]\s*(\d+(?:[,.]\d+)?)\s*(мм|mm|см|cm)\b/i
    ];
    for (const pattern of patterns) {
      const match = source.match(pattern);
      if (!match) continue;
      const unit = match[4] || '';
      const depth = toMillimeters(match[1], unit);
      const width = toMillimeters(match[2], unit);
      const height = toMillimeters(match[3], unit);
      if (depth && width && height) {
        return { depth, width, height, unit: 'mm', raw: match[0] };
      }
    }
    return null;
  }

  function parseWeightText(text) {
    const source = cleanText(text);
    if (!source) return null;
    const match = source.match(/(?:вес(?:\s+товара)?|weight)\D{0,50}(\d+(?:[,.]\d+)?)\s*(кг|kg|г|g|гр|gram|grams|грамм)?/i);
    if (!match) return null;
    const weight = toGrams(match[1], match[2] || 'g');
    return weight ? { weight_g: weight, raw: match[0] } : null;
  }

  function collectTextFragments(value, result = [], depth = 0) {
    if (depth > 5 || result.length > 600) return result;
    if (value == null) return result;
    if (typeof value === 'string') {
      const text = cleanText(value);
      if (text) result.push(text);
      return result;
    }
    if (typeof value === 'number' || typeof value === 'boolean') return result;
    if (Array.isArray(value)) {
      for (const item of value) collectTextFragments(item, result, depth + 1);
      return result;
    }
    if (typeof value === 'object') {
      for (const item of Object.values(value)) collectTextFragments(item, result, depth + 1);
    }
    return result;
  }

  function extractRichTextContent(value) {
    if (value == null) return '';
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return cleanText(value);
    if (Array.isArray(value)) {
      return cleanText(value.map((item) => extractRichTextContent(item)).filter(Boolean).join(' '));
    }
    if (typeof value === 'object') {
      return cleanText(value.content ?? value.text ?? value.value ?? value.title ?? value.name ?? value.textRs ?? '');
    }
    return '';
  }

  function extractCharacteristicsFromWidget(value) {
    const list = Array.isArray(value?.characteristics)
      ? value.characteristics.flatMap((item) => (Array.isArray(item?.short) ? item.short : [item]))
      : Array.isArray(value?.items)
        ? value.items
        : Array.isArray(value)
          ? value.flatMap((item) => (Array.isArray(item?.short) ? item.short : [item]))
          : [];
    const result = [];
    const seen = new Set();
    for (const item of list) {
      const title = extractRichTextContent(item?.title?.textRs || item?.title || item?.name || item?.label);
      const values = (Array.isArray(item?.values) ? item.values : [])
        .map((v) => extractRichTextContent(v?.text ?? v?.value ?? v?.title ?? v?.name ?? v))
        .filter(Boolean);
      if (!title || values.length === 0) continue;
      const key = `${title.toLowerCase()}=${values.join('|').toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      result.push({
        source: 'ozon_characteristics',
        source_id: item?.id || '',
        name: title,
        title,
        value: values.length === 1 ? values[0] : values,
        values: values.map((text) => ({ value: text }))
      });
    }
    return result;
  }

  function mergeCharacteristicWidgets(...widgets) {
    const lists = widgets
      .filter(Boolean)
      .flatMap((widget) =>
        Array.isArray(widget?.characteristics)
          ? widget.characteristics.flatMap((item) => (Array.isArray(item?.short) ? item.short : [item]))
          : Array.isArray(widget)
            ? widget.flatMap((item) => (Array.isArray(item?.short) ? item.short : [item]))
            : []
      );
    if (lists.length === 0) return null;
    const seen = new Set();
    const characteristics = [];
    for (const item of lists) {
      const title = extractRichTextContent(item?.title?.textRs || item?.title || item?.name || item?.label);
      const values = (Array.isArray(item?.values) ? item.values : [])
        .map((v) => extractRichTextContent(v?.text ?? v?.value ?? v?.title ?? v?.name ?? v))
        .filter(Boolean);
      const key = `${title.toLowerCase()}=${values.join('|').toLowerCase()}`;
      if (!title || values.length === 0 || seen.has(key)) continue;
      seen.add(key);
      characteristics.push(item);
    }
    return {
      ...(widgets.find((widget) => widget && typeof widget === 'object' && !Array.isArray(widget)) || {}),
      characteristics
    };
  }

  function parseCharacteristicsWidget(widgetStates) {
    const widgets = [
      ...parseAllWidgetStates(widgetStates, 'webCharacteristics-'),
      ...parseAllWidgetStates(widgetStates, 'webShortCharacteristics-'),
      ...parseAllWidgetStates(widgetStates, 'webProductCharacteristics-')
    ];
    return mergeCharacteristicWidgets(...widgets);
  }

  function parseDimensionsValue(value) {
    if (!value) return null;
    if (typeof value === 'object' && !Array.isArray(value)) {
      const depth = value.depth ?? value.length ?? value.l;
      const width = value.width ?? value.w;
      const height = value.height ?? value.h;
      if (depth != null && width != null && height != null) {
        const unit = value.dimension_unit || value.unit || 'mm';
        return {
          depth: toMillimeters(depth, unit),
          width: toMillimeters(width, unit),
          height: toMillimeters(height, unit),
          unit: 'mm',
          raw: `${depth}x${width}x${height}${unit ? ` ${unit}` : ''}`
        };
      }
    }
    return parseDimensionText(String(value));
  }

  function extractStructuredLogistics(value, result = {}, depth = 0) {
    if (depth > 5 || value == null) return result;
    if (Array.isArray(value)) {
      for (const item of value) extractStructuredLogistics(item, result, depth + 1);
      return result;
    }
    if (typeof value !== 'object') return result;

    const keys = Object.keys(value);
    const lowerKeys = new Map(keys.map((key) => [key.toLowerCase(), key]));
    const weightKey = ['weight_g', 'weightg', 'real_weight', 'package_weight', 'custom_weight'].find((key) => lowerKeys.has(key));
    if (!result.weight_g && weightKey) {
      const originalKey = lowerKeys.get(weightKey);
      const unit = value.weight_unit || value.unit || 'g';
      const weight = toGrams(value[originalKey], unit);
      if (weight) result.weight_g = weight;
    }

    const dimensionKey = ['real_dimensions', 'realdimensions', 'dimensions', 'custom_volume', 'package_volume'].find((key) => lowerKeys.has(key));
    if ((!result.depth || !result.width || !result.height) && dimensionKey) {
      const parsed = parseDimensionsValue(value[lowerKeys.get(dimensionKey)]);
      if (parsed?.depth && parsed?.width && parsed?.height) Object.assign(result, parsed);
    }

    const hasExactDimensions = ['depth', 'width', 'height'].every((key) => lowerKeys.has(key));
    if ((!result.depth || !result.width || !result.height) && hasExactDimensions) {
      const unit = value.dimension_unit || value.unit || 'mm';
      const parsed = parseDimensionsValue({
        depth: value[lowerKeys.get('depth')],
        width: value[lowerKeys.get('width')],
        height: value[lowerKeys.get('height')],
        unit
      });
      if (parsed?.depth && parsed?.width && parsed?.height) Object.assign(result, parsed);
    }

    for (const item of Object.values(value)) extractStructuredLogistics(item, result, depth + 1);
    return result;
  }

  function extractLogistics(...sources) {
    const result = {};
    for (const source of sources) extractStructuredLogistics(source, result);

    const text = sources.flatMap((source) => collectTextFragments(source)).join('\n');
    if (!result.weight_g) {
      const parsedWeight = parseWeightText(text);
      if (parsedWeight?.weight_g) result.weight_g = parsedWeight.weight_g;
    }
    if (!result.depth || !result.width || !result.height) {
      const parsedDimensions = parseDimensionText(text);
      if (parsedDimensions?.depth && parsedDimensions?.width && parsedDimensions?.height) {
        Object.assign(result, parsedDimensions);
      }
    }

    const depth = result.depth || '';
    const width = result.width || '';
    const height = result.height || '';
    return {
      weight_g: result.weight_g || '',
      depth,
      width,
      height,
      dimensions: depth && width && height ? { depth, width, height, unit: 'mm' } : null,
      real_dimensions: depth && width && height ? `${depth}x${width}x${height}` : '',
      custom_volume: depth && width && height ? `${depth}x${width}x${height}` : '',
      sourceText: result.raw || ''
    };
  }

  function normalizeVideoUrls(value) {
    const raw = Array.isArray(value) ? value : value ? [value] : [];
    const urls = raw
      .flatMap((item) => {
        if (!item) return [];
        if (typeof item === 'string') return [item];
        if (typeof item === 'object') return [item.url, item.src, item.link, item.href, item.value].filter(Boolean);
        return [String(item)];
      })
      .map((item) => String(item).trim())
      .filter(Boolean);
    return Array.from(new Set(urls));
  }

  function buildCollectionId(sku) {
    const suffix = Math.random().toString(36).slice(2, 8);
    return `ozon_${String(sku || 'unknown')}_${Date.now()}_${suffix}`;
  }

  function normalizeProductUrl(value) {
    try {
      const url = new URL(value || global.location.href, global.location.href);
      url.search = '';
      url.hash = '';
      return `${url.origin}${url.pathname}`;
    } catch (error) {
      return String(value || global.location?.href || '').split('#')[0].split('?')[0];
    }
  }

  function dedupeBySku(items) {
    const seen = new Map();
    for (const item of items || []) {
      if (!item?.sku) continue;
      const sku = String(item.sku);
      if (!seen.has(sku)) {
        seen.set(sku, item);
        continue;
      }
      const previous = seen.get(sku);
      seen.set(sku, {
        ...previous,
        ...item,
        images: previous.images?.length ? previous.images : item.images,
        searchableText: cleanText(item.searchableText) ? item.searchableText : previous.searchableText,
        title: item.title || previous.title,
        coverImage: item.coverImage || previous.coverImage,
        price: item.price ?? previous.price,
        cardPrice: item.cardPrice ?? previous.cardPrice,
        originalPrice: item.originalPrice ?? previous.originalPrice
      });
    }
    return Array.from(seen.values());
  }

  function pushStage(stages, name, status, detail) {
    stages.push({ name, status, detail: detail || '', at: new Date().toISOString() });
  }

  async function withTimeout(promise, ms, fallback) {
    let timer = null;
    try {
      return await Promise.race([
        promise,
        new Promise((resolve) => {
          timer = setTimeout(() => resolve(fallback), ms);
        })
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async function fetchOzonEntrypoint(path, origin = global.location?.origin) {
    const requestUrl = `${origin}/api/entrypoint-api.bx/page/json/v2?url=${encodeURIComponent(path)}`;
    const response = await fetch(requestUrl, { credentials: 'include' });
    if (!response.ok) throw new Error(`Ozon entrypoint failed ${response.status}`);
    const data = await response.json();
    return { requestUrl, data };
  }

  function parseVariantsFromAspects(aspectsState) {
    if (!aspectsState || !Array.isArray(aspectsState.aspects)) return [];
    return dedupeBySku(
      aspectsState.aspects.flatMap((aspect) => {
        if (!Array.isArray(aspect.variants)) return [];
        return aspect.variants.map((variant) => ({
          sku: variant.sku,
          title: variant.data?.title,
          coverImage: cleanImageUrl(variant.data?.coverImage),
          cardPrice: parsePrice(variant.data?.price),
          price: parsePrice(variant.data?.price),
          originalPrice: parsePrice(variant.data?.originalPrice),
          searchableText: variant.data?.searchableText,
          picture: variant.data?.picture
        }));
      })
    );
  }

  async function fetchModalVariants(sku) {
    const result = await fetchOzonEntrypoint(`/modal/aspectsNew?product_id=${sku}`);
    const modal = parseWidgetState(result.data.widgetStates, 'webAspectsModal-');
    const variants = !modal?.aspects
      ? []
      : dedupeBySku(
          modal.aspects.flatMap((aspect) => {
            if (!Array.isArray(aspect.variants)) return [];
            return aspect.variants.map((variant) => ({
              sku: variant.sku,
              title: variant.data?.title,
              coverImage: cleanImageUrl(variant.data?.coverImage),
              cardPrice: parsePrice(variant.data?.price),
              originalPrice: parsePrice(variant.data?.originalPrice),
              searchableText: variant.data?.searchableText,
              picture: variant.data?.picture
            }));
          })
        );
    return {
      requestUrl: result.requestUrl,
      variants,
      raw: modal
    };
  }

  async function fetchProductDetail(sku, options = {}) {
    const includeVariants = options.includeVariants !== false;
    const result = await fetchOzonEntrypoint(`/product/${sku}/`);
    const page = result.data;
    const heading = parseWidgetState(page.widgetStates, 'webProductHeading-');
    const price = parseWidgetState(page.widgetStates, 'webPrice-');
    const gallery = parseWidgetState(page.widgetStates, 'webGallery-');
    const aspects = parseWidgetState(page.widgetStates, 'webAspects-');
    const hashtagsWidget = parseWidgetState(page.widgetStates, 'webHashtags-');
    const characteristics = parseCharacteristicsWidget(page.widgetStates);
    const hashtags = extractHashtagsFromWidget(hashtagsWidget);
    const extractedAttributes = extractCharacteristicsFromWidget(characteristics);
    const categoryMeta = extractCategoryMetaFromPage(page);

    const images = (gallery?.images || []).map((item) => item.src || item.url).filter(Boolean);
    const videos = gallery?.videos || [];
    const logistics = extractLogistics(page, characteristics);
    const pageVariants = parseVariantsFromAspects(aspects).map((variant) => ({
      ...variant,
      images: variant.images?.length
        ? variant.images
        : [variant.coverImage || variant.picture].filter(Boolean)
    }));

    let description = '';
    let seoUrl = '';
    let seoPriceCurrency = extractSeoPriceCurrency(page);
    const ldJson = page.seo?.script?.find((item) => item.type === 'application/ld+json');
    if (ldJson?.innerHTML) {
      try {
        const seo = JSON.parse(ldJson.innerHTML);
        description = seo.description || '';
        seoUrl = seo.offers?.url || '';
        seoPriceCurrency = seoPriceCurrency || String(seo.offers?.priceCurrency || seo.priceCurrency || '').trim().toUpperCase();
      } catch (error) {}
    }

    let variants = pageVariants;
    let modalRequestUrl = '';
    if (includeVariants) {
      const modal = await fetchModalVariants(sku).catch((error) => ({ error, variants: [] }));
      modalRequestUrl = modal.requestUrl || '';
      const bySku = new Map();
      for (const variant of pageVariants) {
        if (variant.sku) bySku.set(String(variant.sku), variant);
      }
      for (const variant of modal.variants || []) {
        if (variant.sku) bySku.set(String(variant.sku), variant);
      }
      variants = Array.from(bySku.values());
    }

    const cardPrice = parsePrice(price?.cardPrice);
    const currentPrice = parsePrice(price?.price);
    const originalPrice = parsePrice(price?.originalPrice);
    return {
      title: heading?.title,
      price: cardPrice ?? currentPrice,
      webPrice: currentPrice,
      originalPrice,
      cardPrice,
      productPrice: cardPrice ?? currentPrice,
      priceCurrency: seoPriceCurrency || detectCurrency(price?.cardPrice || price?.price),
      currency: seoPriceCurrency || detectCurrency(price?.cardPrice || price?.price),
      sku: gallery?.sku || sku,
      coverImage: cleanImageUrl(gallery?.coverImage),
      searchableText: '',
      images,
      videos,
      videoUrls: normalizeVideoUrls(videos),
      category: categoryMeta.category,
      categoryName: categoryMeta.categoryName,
      category_path: categoryMeta.category_path,
      weight_g: logistics.weight_g,
      depth: logistics.depth,
      width: logistics.width,
      height: logistics.height,
      dimensions: logistics.dimensions,
      real_dimensions: logistics.real_dimensions,
      custom_volume: logistics.custom_volume,
      variants,
      attributes: extractedAttributes,
      hashtags,
      description,
      seo_url: seoUrl,
      requestUrls: {
        detail: result.requestUrl,
        modalVariants: modalRequestUrl
      },
      raw: { heading, price, gallery, aspects, characteristics, hashtags: hashtagsWidget, seoPriceCurrency, categoryMeta }
    };
  }

  async function fetchRichDescriptionJson(sku, options = {}) {
    const attempts = Array.isArray(options.paths) && options.paths.length
      ? options.paths
      : [
          `/product/${sku}/?layout_container=pdpPage2column&layout_page_index=2`,
          `/product/${sku}/?layout_page_index=2&layout_container=pdpPage2column`
        ];
    const maxAttempts = Math.max(1, Number(options.retries || 2));
    let best = null;

    for (let attemptIndex = 0; attemptIndex < maxAttempts; attemptIndex += 1) {
      for (const path of attempts) {
        const result = await fetchOzonEntrypoint(path);
        const widgetStates = result?.data?.widgetStates || {};
        const description = pickBestRichDescriptionWidget(widgetStates);
        const hashtagsWidget = parseWidgetState(widgetStates, 'webHashtags-');
        const characteristics = parseCharacteristicsWidget(widgetStates);
        const jsonContent = description?.richAnnotationJson ?? null;
        const payload = {
          requestUrl: result.requestUrl,
          jsonContent: hasUsableJsonContent(jsonContent) ? jsonContent : null,
          hashtags: extractHashtagsFromWidget(hashtagsWidget),
          characteristics,
          attributes: extractCharacteristicsFromWidget(characteristics),
          raw: {
            description: description || null,
            characteristics: characteristics || null,
            hashtags: hashtagsWidget || null
          }
        };

        if (!best) best = payload;

        if (hasUsableJsonContent(payload.jsonContent)) {
          return payload;
        }

        if (payload.characteristics && !best?.characteristics) {
          best = payload;
        }
      }

      if (attemptIndex < maxAttempts - 1) {
        await sleep(350 * (attemptIndex + 1));
      }
    }

    return best || {
      requestUrl: '',
      jsonContent: null,
      hashtags: [],
      characteristics: null,
      attributes: [],
      raw: {
        description: null,
        characteristics: null,
        hashtags: null
      }
    };
  }

  async function mapWithConcurrency(items, limit, worker) {
    const list = Array.isArray(items) ? items : [];
    const results = new Array(list.length);
    let cursor = 0;
    const runners = Array.from({ length: Math.min(Math.max(limit || 4, 1), list.length || 1) }, async () => {
      while (cursor < list.length) {
        const index = cursor;
        cursor += 1;
        results[index] = await worker(list[index], index);
      }
    });
    await Promise.all(runners);
    return results;
  }

  async function fetchAllVariantDetails(seedSku, options = {}) {
    const seedDetail = options.seedDetail || await fetchProductDetail(seedSku, { includeVariants: true });
    const modalVariants = options.maxVariants
      ? (seedDetail.variants || []).slice(0, options.maxVariants)
      : seedDetail.variants || [];
    if (!modalVariants.length) return [];

    const detailRows = await mapWithConcurrency(modalVariants, options.concurrency || 4, async (variant) => {
      const detail = await fetchProductDetail(String(variant.sku), { includeVariants: false });
      return {
        sku: variant.sku,
        title: variant.title,
        price: detail.cardPrice ?? detail.price,
        originalPrice: detail.originalPrice,
        cardPrice: detail.cardPrice,
        coverImage: cleanImageUrl(variant.coverImage),
        images: detail.images || [],
        videos: detail.videos || [],
        videoUrls: normalizeVideoUrls(detail.videos || []),
        hashtags: mergeHashtags(detail.hashtags, variant.hashtags),
        weight_g: detail.weight_g || '',
        depth: detail.depth || '',
        width: detail.width || '',
        height: detail.height || '',
        dimensions: detail.dimensions || null,
        real_dimensions: detail.real_dimensions || '',
        custom_volume: detail.custom_volume || '',
        searchableText: detail.searchableText || variant.searchableText,
        picture: variant.picture || ''
      };
    });

    return dedupeBySku(detailRows.concat(modalVariants));
  }

  function suggestedOldPrice(price, rate = 1) {
    const numeric = Number(price);
    return Number.isFinite(numeric) && numeric > 0
      ? (Math.round(numeric * rate * 2 * 100) / 100).toFixed(2)
      : '';
  }

  function buildFollowEditRows(productDetail, variants = [], options = {}) {
    const oldPriceRate = options.oldPriceRate || 1;
    const attributes = Array.isArray(productDetail.attributes) ? productDetail.attributes : [];
    const rows = variants.length
        ? variants.map((variant) => {
          const hashtags = mergeHashtags(productDetail.hashtags, variant.hashtags);
          const sellPrice = variant.cardPrice ?? variant.price;
          return {
            cover_image: variant.coverImage,
            title: variant.title,
            sku: variant.sku,
            offer_id: '',
            sell_price: sellPrice,
            price: '',
            old_price: suggestedOldPrice(sellPrice || 0, oldPriceRate),
            searchable_text: variant.searchableText,
            images: variant.images,
            videos: normalizeVideoUrls(variant.videos || productDetail.videos || []),
            original_videos: variant.videos || productDetail.videos || [],
            weight_g: variant.weight_g || productDetail.weight_g || '',
            depth: variant.depth || productDetail.depth || '',
            width: variant.width || productDetail.width || '',
            height: variant.height || productDetail.height || '',
            dimensions: variant.dimensions || productDetail.dimensions || null,
            real_dimensions: variant.real_dimensions || productDetail.real_dimensions || '',
            custom_volume: variant.custom_volume || productDetail.custom_volume || '',
            hashtags,
            attributes,
            description: productDetail.description || '',
            seo_url: productDetail.seo_url || ''
          };
        })
      : [
          {
            cover_image: productDetail.coverImage,
            title: productDetail.title,
            sku: productDetail.sku,
            offer_id: '',
            sell_price: productDetail.cardPrice ?? productDetail.price,
            price: '',
            old_price: suggestedOldPrice((productDetail.cardPrice ?? productDetail.price) || 0, oldPriceRate),
            searchable_text: productDetail.searchableText || '',
            images: productDetail.images || [],
            videos: normalizeVideoUrls(productDetail.videos || []),
            original_videos: productDetail.videos || [],
            weight_g: productDetail.weight_g || '',
            depth: productDetail.depth || '',
            width: productDetail.width || '',
            height: productDetail.height || '',
            dimensions: productDetail.dimensions || null,
            real_dimensions: productDetail.real_dimensions || '',
            custom_volume: productDetail.custom_volume || '',
            hashtags: mergeHashtags(productDetail.hashtags),
            attributes,
            description: productDetail.description || '',
            seo_url: productDetail.seo_url || ''
          }
        ];
    return rows;
  }

  function buildSellerRequestSpecs(sku, variantId) {
    return [
      {
        name: 'seller-analytics/what_to_sell/data/v3',
        method: 'POST',
        url: 'https://seller.ozon.ru/api/site/seller-analytics/what_to_sell/data/v3',
        headers: {
          'Content-Type': 'application/json',
          'x-o3-company-id': '<sc_company_id>',
          'x-o3-language': 'zh-Hans'
        },
        body: {
          limit: '50',
          offset: '0',
          filter: { stock: 'any_stock', period: 'monthly', categories: [], sku: String(sku) },
          sort: { key: 'sum_gmv_desc' }
        }
      },
      {
        name: 'search-variant-model',
        method: 'POST',
        url: 'https://seller.ozon.ru/api/v1/search-variant-model',
        headers: {
          'Content-Type': 'application/json',
          'x-o3-company-id': '<sc_company_id>',
          'x-o3-language': 'RU'
        },
        body: { name: String(sku), limit: '50' }
      },
      {
        name: 'search-sku-base',
        method: 'POST',
        url: 'https://seller.ozon.ru/api/v1/search',
        headers: {
          'Content-Type': 'application/json',
          'x-o3-company-id': '<sc_company_id>',
          'x-o3-language': 'RU'
        },
        body: {
          company_id: '<sc_company_id>',
          need_total: true,
          filter: {
            children_nodes: {
              children_nodes: [{ input_leaf: { sku: { values: [String(sku)] } } }],
              operator: 'AND'
            }
          },
          pagination: { limit: '50' },
          is_copy_allowed: false
        }
      },
      {
        name: 'create-bundle-by-variant-id',
        method: 'POST',
        url: 'https://seller.ozon.ru/api/site/seller-prototype/create-bundle-by-variant-id',
        headers: {
          'Content-Type': 'application/json',
          'x-o3-company-id': '<sc_company_id>',
          'x-o3-language': 'RU'
        },
        body: {
          company_id: '<sc_company_id>',
          variant_id: variantId || '<variant_id>',
          source: 'SOURCE_UI_COPY_MERGED'
        }
      }
    ];
  }

  function sendRuntimeMessage(message) {
    return new Promise((resolve, reject) => {
      try {
        if (!global.chrome?.runtime?.sendMessage) {
          reject(new Error('当前环境不支持扩展消息通信'));
          return;
        }
        global.chrome.runtime.sendMessage(message, (response) => {
          const runtimeError = global.chrome?.runtime?.lastError;
          if (runtimeError) {
            reject(new Error(runtimeError.message));
            return;
          }
          resolve(response);
        });
      } catch (error) {
        reject(error);
      }
    });
  }

  async function requestSellerBridgeData(sku, apiType = 'sales', variantId) {
    const requestId = `ozon_erp_seller_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const response = await sendRuntimeMessage({
      type: 'CROSS_TAB_OZON_REQUEST',
      requestId,
      sku: String(sku || ''),
      apiType,
      variantId
    });
    if (!response) {
      throw new Error('seller.ozon.ru 未返回响应');
    }
    if (response.success !== true) {
      throw new Error(response.message || response.error || 'seller.ozon.ru 请求失败');
    }
    return response.data;
  }

  function hasFilledValue(value) {
    if (value === undefined || value === null || value === '') return false;
    if (Array.isArray(value)) return value.length > 0;
    if (typeof value === 'object') return Object.keys(value).length > 0;
    return true;
  }

  function firstFilledValue(source = {}, keys = []) {
    if (!source || typeof source !== 'object') return '';
    for (const key of keys) {
      const value = source[key];
      if (hasFilledValue(value)) return value;
    }
    return '';
  }

  function firstFilledValueDeep(source = {}, keys = [], depth = 0) {
    if (!source || typeof source !== 'object' || depth > 4) return '';
    const wanted = new Set(keys.map((key) => String(key).toLowerCase()));
    for (const [key, value] of Object.entries(source)) {
      if (wanted.has(String(key).toLowerCase()) && hasFilledValue(value)) return value;
    }
    for (const value of Object.values(source)) {
      if (!value || typeof value !== 'object') continue;
      const nested = firstFilledValueDeep(value, keys, depth + 1);
      if (hasFilledValue(nested)) return nested;
    }
    return '';
  }

  function normalizeSellerAttributeText(item = {}) {
    const firstValue = Array.isArray(item?.values) ? item.values[0] : null;
    const value = item?.value ?? item?.attribute_value ?? item?.text ?? firstValue?.value ?? firstValue?.name ?? firstValue?.text;
    if (Array.isArray(value)) return value.map((entry) => normalizeSellerAttributeText(entry)).filter(Boolean).join(', ');
    if (value && typeof value === 'object') {
      return cleanText(value.value ?? value.name ?? value.text ?? value.label ?? value.display_value ?? '');
    }
    return cleanText(value);
  }

  function sellerAttributeTextByIds(attributes = [], ids = []) {
    const wanted = new Set(ids.map((id) => String(id)));
    for (const item of Array.isArray(attributes) ? attributes : []) {
      const key = String(item?.key || item?.attribute_id || item?.attributeId || item?.id || '').trim();
      if (!wanted.has(key)) continue;
      const value = normalizeSellerAttributeText(item);
      if (value) return value;
    }
    return '';
  }

  function sellerMeasurementByAttributeIds(attributes = [], ids = []) {
    const value = sellerAttributeTextByIds(attributes, ids);
    return normalizeSellerMeasurement(value);
  }

  function normalizeSellerPrice(value) {
    if (value === undefined || value === null || value === '') return '';
    if (typeof value === 'number') return Number.isFinite(value) ? value : '';
    if (typeof value === 'object') return normalizeSellerPrice(firstFilledValue(value, ['value', 'amount', 'price', 'rub', 'RUB']));
    const raw = String(value).replace(/\u00a0/g, ' ').trim();
    if (!raw) return '';
    const compact = raw.replace(/[^\d,.-]/g, '');
    if (!compact) return '';
    const lastComma = compact.lastIndexOf(',');
    const lastDot = compact.lastIndexOf('.');
    let normalized = compact;
    if (lastComma > -1 && lastDot > -1) {
      normalized = lastComma > lastDot
        ? compact.replace(/\./g, '').replace(',', '.')
        : compact.replace(/,/g, '');
    } else if (lastComma > -1) {
      normalized = compact.replace(',', '.');
    }
    const numeric = Number(normalized);
    return Number.isFinite(numeric) ? numeric : '';
  }

  function normalizeSellerImageUrl(value) {
    if (!value) return '';
    if (typeof value === 'string') return value.trim();
    if (typeof value !== 'object') return '';
    return normalizeSellerImageUrl(firstFilledValue(value, [
      'url',
      'src',
      'image',
      'imageUrl',
      'image_url',
      'main_image',
      'primary_image',
      'cover',
      'coverUrl',
      'cover_url',
      'big',
      'large',
      'medium',
      'small'
    ]));
  }

  function normalizeSellerImages(...sources) {
    const result = [];
    const append = (value) => {
      if (!value) return;
      if (Array.isArray(value)) {
        value.forEach(append);
        return;
      }
      const imageUrl = normalizeSellerImageUrl(value);
      if (imageUrl && !result.includes(imageUrl)) result.push(imageUrl);
    };
    sources.forEach(append);
    return result;
  }

  function normalizeSellerBrand(value) {
    const text = cleanText(value);
    if (!text) return '';
    return text === 'без бренда' ? '无品牌' : text;
  }

  function normalizeSellerCategoryIds(source = {}) {
    return [source.category1Id, source.category2Id, source.category3Id]
      .map((item) => Number(item))
      .filter((item) => Number.isFinite(item) && item > 0);
  }

  function normalizeSellerBaseCategoryIds(source = {}) {
    const categories = Array.isArray(source.categories) ? source.categories : [];
    return categories
      .map((item) => ({
        id: Number(item?.id),
        level: Number(item?.level)
      }))
      .filter((item) => Number.isFinite(item.id) && item.id > 0)
      .sort((a, b) => (Number.isFinite(a.level) ? a.level : 0) - (Number.isFinite(b.level) ? b.level : 0))
      .map((item) => item.id);
  }

  function normalizeSellerTypeId(source = {}) {
    const value =
      source.description_type_dict_value ??
      source.descriptionTypeDictValue ??
      source.type_id ??
      source.typeId ??
      '';
    const numeric = Number(value);
    return Number.isFinite(numeric) && numeric > 0 ? String(numeric) : '';
  }

  function appendSellerTypeIdToCategoryIds(categoryIds, typeId) {
    const ids = Array.isArray(categoryIds) ? categoryIds.slice() : [];
    const numericTypeId = Number(typeId);
    if (Number.isFinite(numericTypeId) && numericTypeId > 0 && !ids.includes(numericTypeId)) {
      ids.push(numericTypeId);
    }
    return ids;
  }

  function normalizeSellerCategoryPath(source = {}) {
    const category1 = cleanText(source.category1 || '');
    const category3 = cleanText(source.category3 || '');
    if (!category1 || !category3) return '';
    return `${category1}/${category3}`;
  }

  function normalizeSellerCreateMeta(value) {
    if (!value) {
      return { nullableCreateDate: '', createDays: '' };
    }
    const date = value instanceof Date ? value : new Date(value);
    const time = date.getTime();
    if (!Number.isFinite(time)) {
      return { nullableCreateDate: '', createDays: '' };
    }
    const today = new Date();
    const diffDays = Math.floor(Math.abs(today.getTime() - time) / (24 * 60 * 60 * 1000));
    return {
      nullableCreateDate: date.toISOString().slice(0, 10),
      createDays: diffDays
    };
  }

  function normalizeSellerPercentDisplay(value, options = {}) {
    if (value === undefined || value === null || value === '') return '';
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return '';
    const scale = options.scale === 'ratio' ? (numeric >= 0 && numeric <= 1 ? numeric * 100 : numeric) : numeric;
    const digits = Number.isFinite(options.digits) ? options.digits : 2;
    return `${scale.toFixed(digits)}%`;
  }

  function normalizeSellerReturnRate(value) {
    if (value === undefined || value === null || value === '') return '';
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return '';
    const redemptionRate = numeric >= 0 && numeric <= 1 ? numeric * 100 : numeric;
    const returnRate = 100 - redemptionRate;
    if (!Number.isFinite(returnRate)) return '';
    return `${returnRate.toFixed(1)}%`;
  }

  function normalizeSellerCommissionPercent(value) {
    if (value === undefined || value === null || value === '') return '';
    if (typeof value === 'object') {
      return normalizeSellerCommissionPercent(
        value.value ??
        value.percent ??
        value.commission_percent ??
        value.commissionPercent ??
        value.rate ??
        value.amount
      );
    }
    const text = cleanText(value);
    if (!text) return '';
    const numeric = normalizeSellerPrice(text);
    if (numeric === '') return text;
    const percent = numeric > 0 && numeric <= 1 ? numeric * 100 : numeric;
    return Number.isInteger(percent) ? String(percent) : String(Math.round(percent * 100) / 100);
  }

  function normalizeSellerCommissionSchema(value, fallback = '') {
    return cleanText(value || fallback).toLowerCase();
  }

  function normalizeSellerCommissionEntry(entry, fallbackSchema = '') {
    if (entry === undefined || entry === null || entry === '') return null;
    if (typeof entry !== 'object') {
      const value = normalizeSellerCommissionPercent(entry);
      return value ? { sales_schema: normalizeSellerCommissionSchema(fallbackSchema, 'fbs'), value } : null;
    }
    const schema = normalizeSellerCommissionSchema(
      entry.sales_schema ||
      entry.sale_schema ||
      entry.salesSchema ||
      entry.delivery_schema ||
      entry.deliverySchema ||
      entry.schema ||
      entry.name ||
      entry.type,
      fallbackSchema
    );
    const value = normalizeSellerCommissionPercent(entry);
    if (!value) return null;
    return {
      ...entry,
      sales_schema: schema || 'fbs',
      value
    };
  }

  function normalizeSellerCommissions(...sources) {
    const result = [];
    const seen = new Set();
    const append = (value, fallbackSchema = '') => {
      if (value === undefined || value === null || value === '') return;
      if (typeof value === 'string') {
        const text = value.trim();
        if (!text) return;
        if ((text.startsWith('{') && text.endsWith('}')) || (text.startsWith('[') && text.endsWith(']'))) {
          try {
            append(JSON.parse(text), fallbackSchema);
            return;
          } catch (error) {}
        }
      }
      if (Array.isArray(value)) {
        value.forEach((item) => append(item, fallbackSchema));
        return;
      }
      if (value && typeof value === 'object' && !('value' in value) && !('percent' in value) && !('rate' in value) && !('commission_percent' in value)) {
        for (const [key, item] of Object.entries(value)) append(item, key);
        return;
      }
      const entry = normalizeSellerCommissionEntry(value, fallbackSchema);
      if (!entry) return;
      const key = `${entry.sales_schema}:${entry.value}`;
      if (seen.has(key)) return;
      seen.add(key);
      result.push(entry);
    };

    for (const source of sources) {
      if (!source || typeof source !== 'object') continue;
      append(source.category_commission || source.categoryCommission);
      append(source.commissions || source.commission);
      append(source.fbo_commission || source.fboCommission || source.fbo_rate || source.fboRate, 'fbo');
      append(source.fbs_commission || source.fbsCommission || source.fbs_rate || source.fbsRate, 'fbs');
      append(source.rfbs_commission || source.rfbsCommission || source.rfbs_rate || source.rfbsRate, 'rfbs');
      append(source.commission_percent || source.commissionPercent || source.commission_rate || source.commissionRate, source.salesSchema || source.sales_schema || 'fbs');
    }
    return result;
  }

  function applySellerCommissionFields(target, ...sources) {
    if (!target || typeof target !== 'object') return target;
    const commissions = normalizeSellerCommissions(...sources);
    if (commissions.length === 0) return target;
    target.category_commission = target.category_commission || commissions;
    target.commissions = target.commissions || commissions;
    for (const item of commissions) {
      const schema = normalizeSellerCommissionSchema(item.sales_schema || item.delivery_schema || item.schema);
      if (!schema) continue;
      const value = normalizeSellerCommissionPercent(item);
      if (!value) continue;
      if (schema.includes('rfbs')) target.rfbs_rate = target.rfbs_rate || value;
      else if (schema.includes('fbo')) target.fbo_rate = target.fbo_rate || value;
      else if (schema.includes('fbs')) target.fbs_rate = target.fbs_rate || value;
    }
    return target;
  }

  function normalizeSellerMeasurement(value) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return '';
    return formatMeasurement(numeric);
  }

  function normalizeSellerWeightMeasurement(value, unit = '') {
    const numeric = normalizeDecimal(value && typeof value === 'object' ? (value.value ?? value.amount ?? '') : value);
    if (numeric == null) return '';
    const sourceUnit = String(unit || value?.unit || value?.weight_unit || value || '').trim().toLowerCase();
    return formatMeasurement((sourceUnit.includes('kg') || sourceUnit.includes('кг')) ? numeric * 1000 : numeric);
  }

  function buildSellerSalesFields(source = {}) {
    if (!source || typeof source !== 'object') return {};
    const result = { ...source };
    const categoryIds = normalizeSellerCategoryIds(source);
    const categoryPath = normalizeSellerCategoryPath(source);
    const createMeta = normalizeSellerCreateMeta(source.nullableCreateDate);
    const views = Number(source.views) || 0;
    const qtyViewPdp = Number(source.qtyViewPdp) || 0;
    const clickRate = views > 0 && qtyViewPdp > 0 ? `${(qtyViewPdp / views * 100).toFixed(2)}%` : '';

    if (source.soldSum !== undefined && source.soldSum !== null && source.soldSum !== '') {
      result.soldSum = source.soldSum;
      if (result.soldSumRub === undefined || result.soldSumRub === null || result.soldSumRub === '') {
        result.soldSumRub = source.soldSum;
      }
    }
    if (source.variantId !== undefined && source.variantId !== null && source.variantId !== '') {
      result.variantId = source.variantId;
    }
    if (hasFilledValue(source.photo)) {
      result.productImage = result.productImage || source.photo;
      result.mainImage = result.mainImage || source.photo;
      result.images = normalizeSellerImages(source.photo, result.images);
    }
    if (hasFilledValue(source.link)) {
      result.productLink = result.productLink || source.link;
      result.productUrl = result.productUrl || source.link;
    }
    const avgPrice = normalizeSellerPrice(source.avgPrice);
    if (avgPrice !== '') {
      result.avgPrice = source.avgPrice;
      result.price = result.price || avgPrice;
      result.productPrice = result.productPrice || avgPrice;
      result.sell_price = result.sell_price || avgPrice;
      result.cardPrice = result.cardPrice || avgPrice;
    }

    result.brand = normalizeSellerBrand(source.brand);
    if (categoryPath) result.category = categoryPath;
    if (categoryIds.length > 0) result.category_ids = categoryIds;
    if (clickRate) result.custom_click_rate = clickRate;
    if (createMeta.nullableCreateDate) result.nullableCreateDate = createMeta.nullableCreateDate;
    if (createMeta.createDays !== '') result.createDays = createMeta.createDays;
    if (source.nullableRedemptionRate !== undefined && source.nullableRedemptionRate !== null && source.nullableRedemptionRate !== '') {
      result.nullableRedemptionRate = normalizeSellerReturnRate(source.nullableRedemptionRate);
    }
    applySellerCommissionFields(result, source);
    return result;
  }

  function buildSellerBaseInfoFields(source = {}) {
    const variant = Array.isArray(source?.variants) ? source.variants[0] : source;
    if (!variant || typeof variant !== 'object') return {};
    const result = { ...variant };
    const variantId = variant.variant_id || variant.variantId || '';
    if (variantId) result.variantId = variantId;
    const title = cleanText(variant.variant_name || variant.name || variant.title || '');
    if (title) {
      result.productTitle = title;
      result.name = title;
    }
    const brand = normalizeSellerBrand(variant.brand_name || variant.brand);
    if (brand) result.brand = brand;
    if (hasFilledValue(variant.brand_id)) result.brandId = variant.brand_id;
    const sellerTypeId = normalizeSellerTypeId(variant);
    const categoryIds = appendSellerTypeIdToCategoryIds(normalizeSellerBaseCategoryIds(variant), sellerTypeId);
    if (categoryIds.length > 0) result.category_ids = categoryIds;
    if (!hasFilledValue(result.description_category_id) && categoryIds.length >= 2) {
      result.description_category_id = String(categoryIds[categoryIds.length - 2]);
    }
    if (sellerTypeId) {
      result.type_id = sellerTypeId;
    } else if (!hasFilledValue(result.type_id) && categoryIds.length >= 1) {
      result.type_id = String(categoryIds[categoryIds.length - 1]);
    }
    const images = normalizeSellerImages(variant.main_image, variant.secondary_images, variant.images);
    if (images.length > 0) {
      result.images = images;
      result.productImage = images[0];
      result.mainImage = images[0];
    }
    if (hasFilledValue(variant.rating)) result.rating = variant.rating;
    if (Array.isArray(variant.barcodes) && variant.barcodes.length > 0) result.barcodes = variant.barcodes;
    if (Array.isArray(variant.skus) && variant.skus.length > 0) result.skus = variant.skus;
    if (hasFilledValue(variant.description_type_name)) result.description_type_name = variant.description_type_name;
    if (hasFilledValue(variant.description_type_dict_value)) result.description_type_dict_value = variant.description_type_dict_value;
    return result;
  }

  function extractVariantV1Logistics(source = {}) {
    const attributes = Array.isArray(source.attributes) ? source.attributes : [];
    let depth = '';
    let width = '';
    let height = '';
    let weight = '';

    for (const item of attributes) {
      const key = String(item?.key || item?.attribute_id || item?.attributeId || item?.id || '').trim();
      const firstValue = Array.isArray(item?.values) ? item.values[0] : null;
      const value = item?.value ?? firstValue?.value;
      if (key === '9454') depth = normalizeSellerMeasurement(value);
      if (key === '9455') width = normalizeSellerMeasurement(value);
      if (key === '9456') height = normalizeSellerMeasurement(value);
      if (key === '4497') weight = normalizeSellerWeightMeasurement(value, item?.unit || firstValue?.unit || '');
    }

    const customVolume = depth && width && height ? `${depth}x${width}x${height}` : '';
    return {
      custom_weight: weight || '',
      weight_g: weight || '',
      depth: depth || '',
      width: width || '',
      height: height || '',
      dimensions: customVolume ? { depth, width, height, unit: 'mm' } : null,
      real_dimensions: customVolume || '',
      custom_volume: customVolume || ''
    };
  }

  function extractVariantV2Logistics(source = {}) {
    const item = source?.item && typeof source.item === 'object' ? source.item : source;
    const attributes = Array.isArray(item?.attributes) ? item.attributes : (Array.isArray(source?.attributes) ? source.attributes : []);
    const depth = normalizeSellerMeasurement(firstFilledValueDeep(item, ['depth', 'length', 'length_mm', 'depth_mm'])) || sellerMeasurementByAttributeIds(attributes, ['9454']);
    const width = normalizeSellerMeasurement(firstFilledValueDeep(item, ['width', 'width_mm'])) || sellerMeasurementByAttributeIds(attributes, ['9455']);
    const height = normalizeSellerMeasurement(firstFilledValueDeep(item, ['height', 'height_mm'])) || sellerMeasurementByAttributeIds(attributes, ['9456']);
    const weight = normalizeSellerWeightMeasurement(
      firstFilledValueDeep(item, ['weight_g', 'weight', 'package_weight', 'custom_weight']),
      firstFilledValueDeep(item, ['weight_unit', 'package_weight_unit', 'unit'])
    ) || normalizeSellerWeightMeasurement(sellerAttributeTextByIds(attributes, ['4497']));
    const customVolume = depth && width && height ? `${depth}x${width}x${height}` : '';
    return {
      custom_weight: weight || '',
      weight_g: weight || '',
      depth: depth || '',
      width: width || '',
      height: height || '',
      dimensions: customVolume ? { depth, width, height, unit: 'mm' } : null,
      real_dimensions: customVolume || '',
      custom_volume: customVolume || ''
    };
  }

  function normalizeSellerAttributeValue(value) {
    if (value === undefined || value === null) return null;
    const source = value && typeof value === 'object' ? value : { value };
    const text = source.value ?? source.text ?? source.name ?? source.title;
    const dictionaryValueId = source.dictionary_value_id ?? source.dictionaryValueId ?? source.dictionary_id ?? source.dictionaryId ?? 0;
    if ((text === undefined || text === null || String(text).trim() === '') && !Number(dictionaryValueId)) return null;
    return {
      value: text === undefined || text === null ? '' : String(text),
      dictionary_value_id: String(dictionaryValueId || 0),
      sequence: String(source.sequence ?? 0),
      complex_sequence: String(source.complex_sequence ?? source.complexSequence ?? 0),
      is_default: Boolean(source.is_default ?? source.isDefault ?? false)
    };
  }

  function normalizeSellerVariantAttributes(source = {}) {
    const item = source?.item && typeof source.item === 'object' ? source.item : source;
    const sourceAttributes = Array.isArray(item?.attributes)
      ? item.attributes
      : Array.isArray(source?.attributes)
        ? source.attributes
        : [];
    const result = [];
    const seen = new Set();
    for (const attr of sourceAttributes) {
      const attrId = String(attr?.attribute_id ?? attr?.attributeId ?? attr?.id ?? attr?.key ?? '').trim();
      if (!attrId) continue;
      const complexId = String(attr?.complex_id ?? attr?.complexId ?? 0);
      if (complexId !== '0') continue;
      const rawValues = Array.isArray(attr?.values) ? attr.values : [attr?.value ?? attr?.text ?? attr?.name ?? attr?.title];
      const values = rawValues.map((value) => normalizeSellerAttributeValue(value)).filter(Boolean);
      if (values.length === 0) continue;
      const key = `${attrId}:${values.map((value) => `${value.dictionary_value_id}:${value.value}`).join('|')}`;
      if (seen.has(key)) continue;
      seen.add(key);
      result.push({
        source: 'seller_variant',
        attribute_id: attrId,
        id: attrId,
        values,
        complex_id: complexId
      });
    }
    return result;
  }

  function buildSellerVariantFields(source = {}, options = {}) {
    if (!source || typeof source !== 'object') return {};
    const variantMode = options.variantMode === 'variant_v2' ? 'variant_v2' : 'variant';
    const result = variantMode === 'variant_v2' ? extractVariantV2Logistics(source) : extractVariantV1Logistics(source);
    const item = source?.item && typeof source.item === 'object' ? source.item : source;
    const variantId = source.variant_id || source.variantId || source?.item?.variant_id || source?.item?.variantId || '';
    if (variantId) result.variantId = variantId;
    if (hasFilledValue(source.bundle_id)) result.bundle_id = source.bundle_id;
    if (hasFilledValue(item.offer_id)) result.offer_id = item.offer_id;
    if (hasFilledValue(item.barcode)) result.barcode = item.barcode;
    if (hasFilledValue(item.description_category_id)) result.description_category_id = item.description_category_id;
    if (hasFilledValue(item.new_description_category_id)) result.new_description_category_id = item.new_description_category_id;
    const sellerTypeId = normalizeSellerTypeId(item);
    if (sellerTypeId) result.type_id = sellerTypeId;
    else if (hasFilledValue(item.type_id)) result.type_id = item.type_id;
    if (hasFilledValue(item.origin_variant_id)) result.origin_variant_id = item.origin_variant_id;
    const rawAttributes = Array.isArray(item.attributes) ? item.attributes : (Array.isArray(source.attributes) ? source.attributes : []);
    const color = firstFilledValue(item, ['color', 'color_name', 'colorName']) || sellerAttributeTextByIds(rawAttributes, ['8229', '10096', '22814']);
    const modelName = firstFilledValue(item, ['model_name', 'modelName', 'model']) || sellerAttributeTextByIds(rawAttributes, ['9048']);
    if (hasFilledValue(color)) result.color = color;
    if (hasFilledValue(modelName)) {
      result.modelName = modelName;
      result.spec = result.spec || modelName;
    }
    const itemTitle = item.name || item.title || '';
    if (hasFilledValue(itemTitle) && (!hasFilledValue(color) || cleanText(itemTitle) !== cleanText(color))) {
      result.variantName = itemTitle;
      result.name = result.name || itemTitle;
      result.productTitle = result.productTitle || itemTitle;
    } else if (hasFilledValue(modelName)) {
      result.variantName = result.variantName || modelName;
    }
    const images = normalizeSellerImages(item.primary_image, item.images, item.color_image);
    if (images.length > 0) {
      result.primary_image = item.primary_image || images[0];
      result.images = images;
      result.productImage = images[0];
      result.mainImage = images[0];
    }
    applySellerCommissionFields(result, source, source?.item);
    const attributes = normalizeSellerVariantAttributes(source);
    if (attributes.length > 0) result.attributes = attributes;
    return result;
  }

  async function fetchSellerFallbackData(sku, options = {}) {
    const normalizedSku = String(sku || '').trim();
    if (!normalizedSku) {
      return { fields: {}, raw: {}, warnings: ['missing sku'] };
    }

    const fields = {};
    const warnings = [];
    let sales = null;
    let baseInfo = null;
    let variant = null;
    let variantApiType = 'variant_v2';
    let resolvedVariantId = '';

    try {
      const salesResponse = await requestSellerBridgeData(normalizedSku, 'sales');
      if (Array.isArray(salesResponse?.items) && salesResponse.items.length > 0) {
        sales = salesResponse.items[0];
        Object.assign(fields, buildSellerSalesFields(sales));
        if (hasFilledValue(salesResponse.updateDate)) fields.salesUpdateDate = salesResponse.updateDate;
        if (hasFilledValue(salesResponse.totals)) fields.salesTotals = salesResponse.totals;
        if (hasFilledValue(salesResponse.benchmark)) fields.salesBenchmark = salesResponse.benchmark;
        resolvedVariantId = String(sales.variantId || sales.variant_id || '').trim();
      } else {
        warnings.push('seller sales 未返回商品数据');
      }
    } catch (error) {
      if (options.throwOnSalesError) throw error;
      warnings.push(error?.message || String(error));
    }

    if (!baseInfo) {
      try {
        baseInfo = await requestSellerBridgeData(normalizedSku, 'search-sku-base');
        const categoryIds = fields.category_ids;
        Object.assign(fields, buildSellerBaseInfoFields(baseInfo));
        if (Array.isArray(categoryIds) && categoryIds.length > 0) fields.category_ids = categoryIds;
        if (!resolvedVariantId) {
          resolvedVariantId = String(baseInfo?.variants?.[0]?.variant_id || '').trim();
        }
      } catch (error) {
        if (options.throwOnVariantError) throw error;
        warnings.push(error?.message || String(error));
      }
    }

    if (!resolvedVariantId && !baseInfo) {
      try {
        baseInfo = await requestSellerBridgeData(normalizedSku, 'search-sku-base');
        const categoryIds = fields.category_ids;
        Object.assign(fields, buildSellerBaseInfoFields(baseInfo));
        if (Array.isArray(categoryIds) && categoryIds.length > 0) fields.category_ids = categoryIds;
        resolvedVariantId = String(baseInfo?.variants?.[0]?.variant_id || '').trim();
      } catch (error) {
        if (options.throwOnVariantError) throw error;
        warnings.push(error?.message || String(error));
      }
    }

    if (resolvedVariantId) {
      try {
        variant = await requestSellerBridgeData(normalizedSku, 'variant_v2', resolvedVariantId);
      } catch (error) {
        warnings.push(error?.message || String(error));
        variantApiType = 'variant';
      }
    } else {
      variantApiType = 'variant';
    }

    if (!variant && variantApiType === 'variant') {
      try {
        const variantResponse = await requestSellerBridgeData(normalizedSku, 'variant');
        if (Array.isArray(variantResponse?.items) && variantResponse.items.length > 0) {
          variant = variantResponse.items[0];
        }
      } catch (error) {
        if (options.throwOnVariantError) throw error;
        warnings.push(error?.message || String(error));
      }
    }

    if (variant) {
      Object.assign(fields, buildSellerVariantFields(variant, { variantMode: variantApiType }));
    }

    return {
      fields,
      raw: {
        sales,
        variant,
        baseInfo,
        variantId: resolvedVariantId,
        variantApiType
      },
      warnings
    };
  }

  function normalizeCollectedProduct(productDetail, variants, jsonContent, rows, stages, requestSpecs, collectionId) {
    const sku = String(productDetail.sku || extractOzonSku() || '');
    const images = Array.isArray(productDetail.images) ? productDetail.images : [];
    const hashtags = mergeHashtags(productDetail.hashtags, rows.flatMap((row) => row.hashtags || []));
    const attributes = Array.isArray(productDetail.attributes) ? productDetail.attributes : [];
    const hasAnyDimensions =
      productDetail.weight_g ||
      productDetail.depth ||
      productDetail.width ||
      productDetail.height ||
      rows.some((row) => row.weight_g || row.depth || row.width || row.height);
    const missingFields = [
      productDetail.title ? '' : '标题',
      images.length ? '' : '图片',
      productDetail.description ? '' : '描述',
      productDetail.price != null || productDetail.cardPrice != null ? '' : '价格',
      Array.isArray(variants) && variants.length ? '' : '变体',
      hasAnyDimensions ? '' : '重量/尺寸'
    ].filter(Boolean);

    const followEditPayload = {
      scene: 'plugin',
      sku,
      currecny: 'CNY',
      hashtags,
      attributes,
      rows,
      json_content: jsonContent
    };

    return {
      platform: 'Ozon',
      collectionId,
      productUrl: normalizeProductUrl(global.location?.href || `https://www.ozon.ru/product/${sku}/`),
      fullProductUrl: global.location?.href || '',
      sku,
      productId: sku,
      title: productDetail.title || '',
      price: productDetail.cardPrice ?? productDetail.price ?? null,
      originalPrice: productDetail.originalPrice ?? null,
      cardPrice: productDetail.cardPrice ?? null,
      productPrice: productDetail.cardPrice ?? productDetail.price ?? null,
      currency: 'CNY',
      mainImage: productDetail.coverImage || images[0] || '',
      images,
      videos: productDetail.videos || [],
      videoUrls: normalizeVideoUrls(productDetail.videos || []),
      weight_g: productDetail.weight_g || '',
      depth: productDetail.depth || '',
      width: productDetail.width || '',
      height: productDetail.height || '',
      dimensions: productDetail.dimensions || null,
      real_dimensions: productDetail.real_dimensions || '',
      custom_volume: productDetail.custom_volume || '',
      hashtags,
      description: productDetail.description || '',
      seoUrl: productDetail.seo_url || '',
      variants: Array.isArray(variants) ? variants : [],
      attributes,
      editPayload: {
        collectionId,
        sku,
        title: productDetail.title || '',
        price: productDetail.cardPrice ?? productDetail.price ?? null,
        currency: 'CNY',
        mainImage: productDetail.coverImage || images[0] || '',
        images,
        videos: normalizeVideoUrls(productDetail.videos || []),
        originalVideos: productDetail.videos || [],
        weight_g: productDetail.weight_g || '',
        depth: productDetail.depth || '',
        width: productDetail.width || '',
        height: productDetail.height || '',
        dimensions: productDetail.dimensions || null,
        real_dimensions: productDetail.real_dimensions || '',
        custom_volume: productDetail.custom_volume || '',
        hashtags,
        description: productDetail.description || '',
        attributes,
        variants: Array.isArray(variants) ? variants : [],
        followEditPayload,
        rows,
        jsonContent
      },
      followEditPayload,
      requestSpecs,
      jsonContent,
      collectorStages: stages || [],
      collectedAt: new Date().toISOString(),
      missingFields
    };
  }

  async function collectCurrentProduct(inputSku, options = {}) {
    const stages = [];
    const sku = String(inputSku || extractOzonSku() || '').trim();
    if (!sku) throw new Error('Cannot detect Ozon SKU from current URL');

    pushStage(stages, 'sku', 'success', sku);
    pushStage(stages, 'detail', 'running');
    const productDetail = await fetchProductDetail(sku, { includeVariants: true });
    pushStage(stages, 'detail', 'success', productDetail.title || sku);

    let variants = productDetail.variants || [];
    const descriptionPromise = withTimeout(
      fetchRichDescriptionJson(sku),
      options.descriptionTimeoutMs || 10000,
      { jsonContent: null, requestUrl: '' }
    );
    if (options.includeVariants !== false) {
      pushStage(stages, 'variant_details', 'running', `${variants.length} variants`);
      variants = await fetchAllVariantDetails(sku, {
        maxVariants: options.maxVariants,
        concurrency: options.concurrency || 4,
        seedDetail: productDetail
      }).catch((error) => {
        pushStage(stages, 'variant_details', 'warning', error?.message || 'variant detail failed');
        return productDetail.variants || [];
      });
      pushStage(stages, 'variant_details', 'success', `${variants.length} variants`);
    }

    pushStage(stages, 'rich_description', 'running');
    const descriptionResult = await descriptionPromise;
    const jsonContent = descriptionResult?.jsonContent ?? null;
    productDetail.hashtags = mergeHashtags(productDetail.hashtags, descriptionResult?.hashtags);
    productDetail.raw.characteristics = mergeCharacteristicWidgets(productDetail.raw.characteristics, descriptionResult?.characteristics);
    productDetail.attributes = extractCharacteristicsFromWidget(productDetail.raw.characteristics);
    pushStage(stages, 'rich_description', jsonContent ? 'success' : 'warning', jsonContent ? 'loaded' : 'empty');

    const rows = buildFollowEditRows(productDetail, variants, options);
    const collectionId = buildCollectionId(sku);
    const followEditPayload = {
      scene: 'plugin',
      sku,
      currecny: 'CNY',
      hashtags: productDetail.hashtags || [],
      attributes: productDetail.attributes || [],
      rows,
      json_content: jsonContent
    };
    const allSkus = dedupeBySku([{ sku }].concat(variants || [])).map((item) => String(item.sku));
    const sellerRequestSpecs = allSkus.flatMap((itemSku) => buildSellerRequestSpecs(itemSku));
    const requestSpecs = {
      ozonFrontend: [
        { name: 'product-detail', method: 'GET', url: productDetail.requestUrls.detail },
        { name: 'variant-modal', method: 'GET', url: productDetail.requestUrls.modalVariants },
        { name: 'rich-description', method: 'GET', url: descriptionResult?.requestUrl || '' }
      ].filter((item) => item.url),
      seller: sellerRequestSpecs
    };

    return {
      success: true,
      mode: 'preview-only',
      collectionId,
      sku,
      productDetail,
      variants,
      rows,
      jsonContent,
      followEditPayload,
      requestSpecs,
      normalized: normalizeCollectedProduct(productDetail, variants, jsonContent, rows, stages, requestSpecs, collectionId),
      collectedAt: new Date().toISOString(),
      stages
    };
  }

  function collectListSkuSpecs(limit = 120) {
    const rows = [];
    const seen = new Set();
    for (const link of global.document.querySelectorAll('a[href*="/product/"]')) {
      if (rows.length >= limit) break;
      const sku = extractOzonSku(link.href);
      if (!sku || seen.has(sku)) continue;
      seen.add(sku);
      rows.push({
        sku,
        url: normalizeProductUrl(link.href),
        title: cleanText(link.textContent || link.getAttribute('title') || '')
      });
    }
    return rows;
  }

  async function runDetailAutoFeature(options = {}) {
    return await collectCurrentProduct(null, options);
  }

  global.OzonErpCollector = {
    version: VERSION,
    skuRegex: SKU_RE,
    extractOzonSku,
    fetchOzonEntrypoint,
    fetchProductDetail,
    fetchModalVariants,
    fetchAllVariantDetails,
    fetchRichDescriptionJson,
    extractLogistics,
    normalizeVideoUrls,
    buildFollowEditRows,
    buildSellerRequestSpecs,
    fetchSellerFallbackData,
    requestSellerBridgeData,
    collectListSkuSpecs,
    collectCurrentProduct,
    runDetailAutoFeature,
  };
})(window);
