window.WardWiseExplorer = {
  // Pure year-honesty math shared by the explorer and the Reports views. Callers supply a ctx
  // built from the manifest: {metricDataYears, forwardCarryYears, timeInvariantMetrics (Set),
  // metricValidFrom}. Semantics mirror the explorer exactly: a vintage carries forward
  // forwardCarryYears but never back; time-invariant facts apply from their valid_from; a change
  // window requires an actual remeasurement between its endpoints.
  yearMath: {
    hasValueForYear(ctx, metricId, target) {
      const years = (ctx.metricDataYears[metricId] || []).map(Number);
      if (years.some((m) => m <= target && target - m <= ctx.forwardCarryYears)) return true;
      if (ctx.timeInvariantMetrics.has(metricId)) {
        const validFrom = ctx.metricValidFrom[metricId];
        return validFrom == null || target >= validFrom;
      }
      return false;
    },
    latestMeasurementFor(ctx, metricId, target) {
      const years = (ctx.metricDataYears[metricId] || []).map(Number);
      const usable = years.filter((m) => m <= target && target - m <= ctx.forwardCarryYears);
      return usable.length ? Math.max(...usable) : null;
    },
    deltaExclusionReason(ctx, metricId, from, to) {
      if (ctx.timeInvariantMetrics.has(metricId)) return "constant by definition";
      const a = this.latestMeasurementFor(ctx, metricId, from);
      const b = this.latestMeasurementFor(ctx, metricId, to);
      if (a == null && b == null) return "no data in this window";
      if (a == null) {
        const first = Math.min(...(ctx.metricDataYears[metricId] || []).map(Number));
        return `not measured until ${first}`;
      }
      if (b == null) return "no data at the end year";
      if (a === b) return `single ${a} vintage — not remeasured in this window`;
      return null;
    },
  },

  // Single safe entry point for Google Analytics events (GA4 is wired in base.html
  // when GOOGLE_ANALYTICS_ID is set). Never let analytics throw into the app.
  track(action, params = {}) {
    try {
      if (typeof window.gtag === "function") {
        window.gtag("event", action, params);
      }
    } catch (_error) {
      /* analytics is best-effort */
    }
  },

  async fetchWards() {
    return this.fetchJson("/api/wards", "Unable to load wards.");
  },

  async fetchExplorerWards() {
    return this.fetchJson("/api/explorer/wards", "Unable to load wards.");
  },

  async fetchWardGeojson() {
    return this.fetchJson("/api/wards.geojson", "Unable to load ward geometry.");
  },

  async fetchWardDetails(wardId) {
    return this.fetchJson(`/api/wards/${wardId}`, "Unable to load ward details.");
  },

  async fetchWardPlaces(wardId) {
    return this.fetchJson(`/api/wards/${wardId}/places`, "Unable to load places of interest.");
  },

  async fetchWardCommunityAreas(wardId) {
    return this.fetchJson(
      `/api/wards/${wardId}/community-areas`,
      "Unable to load community areas.",
    );
  },

  async fetchCommunityAreas() {
    return this.fetchJson("/api/community-areas", "Unable to load community areas.");
  },

  async fetchCommunityAreaGeojson() {
    return this.fetchJson("/api/community-areas.geojson", "Unable to load neighborhood geometry.");
  },

  async fetchChis() {
    return this.fetchJson("/api/chis", "Unable to load chis.");
  },

  async fetchChigridGeojson() {
    return this.fetchJson("/api/chigrid.geojson", "Unable to load chi geometry.");
  },

  async fetchMetrics() {
    return this.fetchJson("/api/metrics", "Unable to load metrics.");
  },

  async fetchExplorerManifest() {
    return this.fetchJson("/api/explorer/manifest", "Unable to load metrics.");
  },

  async fetchScores(weights, areaType = "ward", year = null) {
    const params = this.weightParams(weights);
    if (areaType && areaType !== "ward") params.set("area_type", areaType);
    if (year) params.set("year", year);
    const query = params.toString();
    return this.fetchJson(
      `/api/metrics/scores${query ? `?${query}` : ""}`,
      "Unable to load metric scores.",
    );
  },

  async fetchDelta(metricId, fromYear, toYear, areaType = "ward") {
    const params = new URLSearchParams();
    params.set("metric_id", metricId);
    params.set("from_year", fromYear);
    params.set("to_year", toYear);
    if (areaType && areaType !== "ward") params.set("area_type", areaType);
    return this.fetchJson(
      `/api/metrics/delta?${params.toString()}`,
      "Unable to load change-over-time data.",
    );
  },

  async fetchScoreDetails(areaId, weights, areaType = "ward") {
    const params = this.weightParams(weights);
    params.set("ward_id", areaId);
    if (areaType && areaType !== "ward") {
      params.set("area_type", areaType);
      params.set("area_id", areaId);
    }
    return this.fetchJson(
      `/api/metrics/scores/details?${params.toString()}`,
      "Unable to load metric score details.",
    );
  },

  async fetchComparison(metricIds, areaType = "ward") {
    const params = new URLSearchParams();
    if (metricIds?.length) params.set("metrics", metricIds.join(","));
    if (areaType) params.set("area_type", areaType);
    return this.fetchJson(`/api/metrics/comparison?${params.toString()}`, "Unable to load comparison data.");
  },

  async fetchTimeline({ metricIds = [], areaType = "ward", areaId } = {}) {
    const params = new URLSearchParams();
    if (metricIds.length) params.set("metrics", metricIds.join(","));
    if (areaType) params.set("area_type", areaType);
    if (areaId) params.set("area_id", areaId);
    return this.fetchJson(`/api/metrics/timeline?${params.toString()}`, "Unable to load history.");
  },

  async fetchTimeseries({ metricId, areaType = "ward", areaId } = {}) {
    const params = new URLSearchParams();
    if (metricId) params.set("metric_id", metricId);
    if (areaType) params.set("area_type", areaType);
    if (areaId) params.set("area_id", areaId);
    return this.fetchJson(`/api/metrics/timeseries?${params.toString()}`, "Unable to load history.");
  },

  async submitMetricRecommendation(payload) {
    return this.postJson(
      "/api/metric-recommendations",
      payload,
      "Unable to send your recommendation.",
    );
  },

  async submitMetricSelectionEvent(payload) {
    return this.postJson(
      "/api/metric-selection-events",
      payload,
      "Unable to record metric selection.",
    );
  },

  async fetchMetricRecommendations() {
    return this.fetchJson(
      "/api/metric-recommendations",
      "Unable to load metric recommendations.",
    );
  },

  async fetchMetricSubmissions() {
    return this.fetchJson(
      "/api/metric-submissions",
      "Unable to load metric submissions.",
    );
  },

  async updateMetricSubmission(submissionId, payload) {
    return this.patchJson(
      `/api/metric-submissions/${encodeURIComponent(submissionId)}`,
      payload,
      "Unable to update metric submission.",
    );
  },

  async fetchAccessUsers() {
    return this.fetchJson("/api/admin/users", "Unable to load approved users.");
  },

  async addAccessUser(payload) {
    return this.postJson("/api/admin/users", payload, "Unable to add approved user.");
  },

  async deleteAccessUser(email) {
    return this.deleteJson(
      `/api/admin/users/${encodeURIComponent(email)}`,
      "Unable to remove approved user.",
    );
  },

  async fetchApiKeys() {
    return this.fetchJson("/api/admin/api-keys", "Unable to load API keys.");
  },

  async createApiKey(payload) {
    return this.postJson("/api/admin/api-keys", payload, "Unable to create the key.");
  },

  async revokeApiKey(keyId) {
    return this.deleteJson(`/api/admin/api-keys/${encodeURIComponent(keyId)}`, "Unable to revoke the key.");
  },

  async fetchAdminMetricMetadata() {
    return this.fetchJson(
      "/api/admin/metrics/metadata",
      "Unable to load metric metadata.",
    );
  },

  async updateAdminMetricMetadata(metricId, payload) {
    return this.patchJson(
      `/api/admin/metrics/${encodeURIComponent(metricId)}/metadata`,
      payload,
      "Unable to update metric metadata.",
    );
  },

  async fetchJson(url, errorMessage) {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(errorMessage);
    }
    return response.json();
  },

  async postJson(url, payload, errorMessage) {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const validationMessage = this.formatValidationErrors(data.fields);
      throw new Error(validationMessage || data.error || errorMessage);
    }
    return data;
  },

  async deleteJson(url, errorMessage) {
    const response = await fetch(url, { method: "DELETE" });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const validationMessage = this.formatValidationErrors(data.fields);
      throw new Error(validationMessage || data.error || errorMessage);
    }
    return data;
  },

  async patchJson(url, payload, errorMessage) {
    const response = await fetch(url, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const validationMessage = this.formatValidationErrors(data.fields);
      throw new Error(validationMessage || data.error || errorMessage);
    }
    return data;
  },

  formatValidationErrors(fields) {
    if (!fields || typeof fields !== "object") return "";
    return Object.values(fields).filter(Boolean).join(" ");
  },

  weightQuery(weights) {
    const params = this.weightParams(weights);
    const query = params.toString();
    return query ? `?${query}` : "";
  },

  weightParams(weights) {
    const params = new URLSearchParams();
    Object.entries(weights || {}).forEach(([metricId, weight]) => {
      params.set(`weight_${metricId}`, weight);
    });
    return params;
  },

  escapeHtml(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  },

  formatNumber(value, options = {}) {
    const numericValue = Number(value);
    if (!Number.isFinite(numericValue)) return "No data";
    return new Intl.NumberFormat(undefined, options).format(numericValue);
  },

  formatMetricValue(value, metric) {
    if (value === null || value === undefined) return "No data";
    if (metric?.unit === "rating") {
      return this.formatNumber(value, { maximumFractionDigits: 2 });
    }
    if (metric?.unit === "percent") {
      return `${this.formatNumber(value, { maximumFractionDigits: 1 })}%`;
    }
    if (metric?.unit === "currency") {
      return this.formatNumber(value, {
        maximumFractionDigits: 0,
        style: "currency",
        currency: "USD",
      });
    }
    if (metric?.unit === "miles") {
      return `${this.formatNumber(value, { maximumFractionDigits: 2 })} mi`;
    }
    if (metric?.unit === "rate_per_10000") {
      return `${this.formatNumber(value, { maximumFractionDigits: 1 })} per 10k`;
    }
    return this.formatNumber(value, { maximumFractionDigits: 1 });
  },

  formatCategory(category) {
    return this.escapeHtml(String(category || "").replaceAll("_", " "));
  },

  formatDate(value) {
    if (!value) return "Not recorded";
    return new Date(value).toLocaleDateString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  },

  formatDateTime(value) {
    if (!value) return "Not recorded";
    return new Date(value).toLocaleString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  },
};
