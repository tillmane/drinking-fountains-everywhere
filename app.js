(function () {
  "use strict";

  var API_BASE = "https://drinking-fountains-api.urbanfreerunners.com";

  var ARCGIS_URL =
    "https://services.arcgis.com/ZOyb2t4B0UYuYNYH/arcgis/rest/services/Drinking_Fountain/FeatureServer/0/query";
  var OVERPASS_URL = "https://overpass-api.de/api/interpreter";
  var NOMINATIM_URL = "https://nominatim.openstreetmap.org/search";
  var SEATTLE_CENTER = [47.6062, -122.3321];
  var SEATTLE_BOUNDS = "47.3,-122.5,47.8,-122.1";
  var DEFAULT_ZOOM = 13;
  var SEARCH_ZOOM = 16;

  function getDeviceId() {
    var key = "fountain_device_id";
    var id = localStorage.getItem(key);
    if (!id) {
      id = crypto.randomUUID();
      localStorage.setItem(key, id);
    }
    return id;
  }
  var deviceId = getDeviceId();

  var fountainIndex = {};
  var fountainIndexLoaded = false;
  var powerUserMode = false;
  var myRatings = {}; // fountainId -> 0 | 1 | null

  var map = L.map("map", {
    center: SEATTLE_CENTER,
    zoom: DEFAULT_ZOOM,
    zoomControl: true,
  });

  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    maxZoom: 19,
  }).addTo(map);

  var userMarker = null;
  var cachedPosition = null;
  var locationDenied = false;

  var activeFilters = {
    accessible: false,
    bottle: false,
    dog: false,
  };

  var sources = {
    city: { layerGroup: L.layerGroup().addTo(map), data: [], visible: true },
    osm:  { layerGroup: L.layerGroup().addTo(map), data: [], visible: true },
  };

  var OSM_MATCH_METERS = 30;
  var layerOptions = {
    cityUniqueOnly: false,
    ratingFilter: null, // null | "rated" | "unrated"
  };

  function cityHasOsmMatch(f) {
    var cityLatLng = L.latLng(f.LATITUDE, f.LONGITUDE);
    return sources.osm.data.some(function (el) {
      return cityLatLng.distanceTo([el.lat, el.lon]) <= OSM_MATCH_METERS;
    });
  }

  function isYes(val) {
    return typeof val === "string" && val.toUpperCase() === "YES";
  }

  function isCityRunning(f) {
    return f.CURRENT_STATUS === "ON" || f.CURRENT_STATUS === null || f.CURRENT_STATUS === undefined;
  }

  function isReportedOff(sourceType, sourceId) {
    var local = lookupFountain(sourceType, sourceId);
    return local && local.reported_off;
  }

  function hasBottleFiller(sourceType, sourceId, sourceData) {
    if (sourceType === "city_gis") return isYes(sourceData.BOTTLE_FILLER);
    if (sourceType === "osm") return sourceData.tags && sourceData.tags.bottle === "yes";
    return false;
  }

  function hasDogBowl(sourceType, sourceId, sourceData) {
    if (sourceType === "city_gis") return isYes(sourceData.DOG_BOWL);
    if (sourceType === "osm") return sourceData.tags && sourceData.tags.dog === "yes";
    return false;
  }

  function fountainHasAccessible(sourceType, sourceId, sourceData) {
    var local = lookupFountain(sourceType, sourceId);
    if (local && local.user_accessible) return true;
    if (sourceType === "city_gis") return isYes(sourceData.ACCESSIBLE_MODEL);
    if (sourceType === "osm") return (sourceData.tags || {}).wheelchair === "yes";
    return false;
  }

  function fountainHasBottle(sourceType, sourceId, sourceData) {
    var local = lookupFountain(sourceType, sourceId);
    if (local && local.user_bottle_filler) return true;
    return hasBottleFiller(sourceType, sourceId, sourceData);
  }

  function fountainHasDog(sourceType, sourceId, sourceData) {
    var local = lookupFountain(sourceType, sourceId);
    if (local && local.user_dog_bowl) return true;
    return hasDogBowl(sourceType, sourceId, sourceData);
  }

  var X_ICON = '<line x1="9" y1="10" x2="19" y2="20" stroke="#fff" stroke-width="2.2" stroke-linecap="round" opacity="0.9"/>' +
    '<line x1="19" y1="10" x2="9" y2="20" stroke="#fff" stroke-width="2.2" stroke-linecap="round" opacity="0.9"/>';

  var QUESTION_ICON = '<text x="14" y="19" text-anchor="middle" fill="#fff" font-size="15" font-weight="bold" font-family="Arial, sans-serif" opacity="0.9">?</text>';

  var THUMB_UP   = '<text x="14" y="20" text-anchor="middle" font-size="14" font-family="Apple Color Emoji, Segoe UI Emoji, sans-serif">👍</text>';
  var THUMB_DOWN = '<text x="14" y="20" text-anchor="middle" font-size="14" font-family="Apple Color Emoji, Segoe UI Emoji, sans-serif">👎</text>';

  function makeIcon(color, inner) {
    return L.divIcon({
      className: "fountain-marker",
      html: '<svg width="28" height="36" viewBox="0 0 28 36" xmlns="http://www.w3.org/2000/svg">' +
        '<path d="M14 0C6.27 0 0 6.27 0 14c0 10.5 14 22 14 22s14-11.5 14-22C28 6.27 21.73 0 14 0z" fill="' + color + '" stroke="#fff" stroke-width="1.5"/>' +
        inner +
      '</svg>',
      iconSize: [28, 36],
      iconAnchor: [14, 36],
      popupAnchor: [0, -30],
    });
  }

  var icons = {
    cityOff:     makeIcon("#c62828", X_ICON),
    reportedOff: makeIcon("#e67e22", X_ICON),
  };

  function lookupFountain(sourceType, sourceId) {
    return fountainIndex[sourceType + ":" + sourceId] || null;
  }

  function isRated(sourceType, sourceId) {
    var local = lookupFountain(sourceType, sourceId);
    return local && local.rating_count > 0;
  }

  function passesRatingFilter(sourceType, sourceId) {
    if (!layerOptions.ratingFilter) return true;
    var rated = isRated(sourceType, sourceId);
    return layerOptions.ratingFilter === "rated" ? rated : !rated;
  }

  function getPinStateForFountain(sourceType, sourceId) {
    if (!fountainIndexLoaded) return "unrated";
    var local = lookupFountain(sourceType, sourceId);
    if (!local || !local.rating_count) return "unrated";
    if (local.thumbs_down > local.thumbs_up) return "down";
    return "up";
  }

  function formatRelativeDate(isoString) {
    if (!isoString) return "";
    var date = new Date(isoString);
    var now = new Date();
    var diffMs = now - date;
    var diffDays = Math.floor(diffMs / 86400000);
    if (diffDays === 0) return "today";
    if (diffDays === 1) return "yesterday";
    if (diffDays < 7) return diffDays + " days ago";
    if (diffDays < 30) return Math.floor(diffDays / 7) + "w ago";
    var month = date.toLocaleString("en-US", { month: "short" });
    return month + " " + date.getDate();
  }

  function buildReactionButtons(fountainId, thumbsUp, thumbsDown, yourScore) {
    var upActive = yourScore === 1 ? " active" : "";
    var downActive = yourScore === 0 ? " active" : "";
    return '<div class="reactions">' +
      '<div class="reaction-col">' +
        '<button class="reaction-btn' + upActive + '" data-fountain-id="' + fountainId + '" data-score="1">👍 <span class="reaction-count">' + (thumbsUp || 0) + '</span></button>' +
        '<div class="reaction-label">Good water — reliable, clean, decent pressure</div>' +
      '</div>' +
      '<div class="reaction-col">' +
        '<button class="reaction-btn' + downActive + '" data-fountain-id="' + fountainId + '" data-score="0">👎 <span class="reaction-count">' + (thumbsDown || 0) + '</span></button>' +
        '<div class="reaction-label">Not worth the detour — very low pressure, extremely dirty, etc</div>' +
      '</div>' +
    '</div>';
  }

  var TOOLTIPS = {
    accessible: "Features a fountain accessible to wheelchair users",
    dog_bowl:   "Features a near-ground fountain or basin for pet access",
  };

  function tooltipIcon(key) {
    return '<button class="attr-tooltip-btn" data-tooltip="' + TOOLTIPS[key] + '" aria-label="More info" type="button">?</button>';
  }

  function buildAttributeSection(local, sourceAccessible) {
    if (!local) return "";
    var accessibleChecked = (sourceAccessible || local.user_accessible) ? " checked" : "";
    var bottleChecked = local.user_bottle_filler ? " checked" : "";
    var dogChecked = local.user_dog_bowl ? " checked" : "";
    return '<div class="attr-section">' +
      '<div class="attr-checkbox-row">' +
        '<input type="checkbox" id="attr-accessible-' + local.id + '" class="attr-checkbox" data-fountain-id="' + local.id + '" data-attribute="accessible"' + accessibleChecked + '>' +
        '<label for="attr-accessible-' + local.id + '">Accessible</label>' +
        tooltipIcon("accessible") +
      '</div>' +
      '<div class="attr-checkbox-row">' +
        '<input type="checkbox" id="attr-bottle-' + local.id + '" class="attr-checkbox" data-fountain-id="' + local.id + '" data-attribute="bottle_filler"' + bottleChecked + '>' +
        '<label for="attr-bottle-' + local.id + '">Bottle Filler</label>' +
      '</div>' +
      '<div class="attr-checkbox-row">' +
        '<input type="checkbox" id="attr-dog-' + local.id + '" class="attr-checkbox" data-fountain-id="' + local.id + '" data-attribute="dog_bowl"' + dogChecked + '>' +
        '<label for="attr-dog-' + local.id + '">Dog Bowl</label>' +
        tooltipIcon("dog_bowl") +
      '</div>' +
    '</div>';
  }

  function buildRatingSection(sourceType, sourceId, sourceOff) {
    var local = lookupFountain(sourceType, sourceId);
    if (!fountainIndexLoaded) {
      return '<div class="rating-section"><p class="rating-unavailable">Loading ratings…</p></div>';
    }
    if (!local) {
      return '<div class="rating-section"><p class="rating-unavailable">Ratings coming soon</p></div>';
    }

    if (sourceOff) {
      return '<div class="rating-section" data-fountain-id="' + local.id + '">' +
        '<p class="rating-unavailable">Ratings disabled — fountain shut off by city</p>' +
      '</div>';
    }

    var lastRated = local.last_rated_at
      ? "Last rated " + formatRelativeDate(local.last_rated_at)
      : "";

    var reportHtml = "";
    var reportBtnHtml = "";
    if (local.reported_off) {
      reportHtml = '<div class="report-status reported-off">Reported off (' + local.off_reports + ') as of ' + formatRelativeDate(local.last_off_report_at) + '</div>';
      reportBtnHtml = '<button class="report-btn report-on-btn" data-fountain-id="' + local.id + '" data-status="on">Report on</button>';
    } else {
      reportBtnHtml = '<button class="report-btn report-off-btn" data-fountain-id="' + local.id + '" data-status="off">Report off</button>';
    }

    return '<div class="rating-section" data-fountain-id="' + local.id + '">' +
      reportHtml +
      buildReactionButtons(local.id, local.thumbs_up, local.thumbs_down, myRatings[local.id] !== undefined ? myRatings[local.id] : null) +
      (lastRated ? '<div class="rating-last">' + lastRated + '</div>' : '') +
      '<div class="report-actions">' + reportBtnHtml + '</div>' +
    '</div>';
  }

  function buildCityPopup(f) {
    var running = isCityRunning(f);
    var local = lookupFountain("city_gis", String(f.OBJECTID));
    var detailsHtml = "";
    if (!running)
      detailsHtml += '<div class="details"><div><span class="detail-label">Reason Off:</span> ' + (f.REASON_OFF || "UNKNOWN") + '</div></div>';

    return '<div class="fountain-popup">' +
      (running ? "" : '<span class="status off">Shut Off</span>') +
      detailsHtml +
      buildRatingSection("city_gis", String(f.OBJECTID), !running) +
      buildAttributeSection(local, isYes(f.ACCESSIBLE_MODEL)) +
      '<div class="popup-footer">' +
        (f.PARK ? '<div class="popup-name">' + f.PARK + '</div>' : '') +
        '<div class="popup-source">Seattle City GIS</div>' +
      '</div>' +
    '</div>';
  }

  function buildOsmPopup(el) {
    var tags = el.tags || {};
    var local = lookupFountain("osm", String(el.id));

    var title = null;
    if (local) {
      var citySource = (local.sources || []).find(function (s) { return s.source_type === "city_gis"; });
      if (citySource) {
        var cityRecord = sources.city.data.find(function (f) { return String(f.OBJECTID) === citySource.source_id; });
        if (cityRecord && cityRecord.PARK) title = cityRecord.PARK;
      }
    }
    if (!title && tags.name && tags.name !== "Drinking Fountain") title = tags.name;

    var detailsHtml = "";
    if (tags.check_date)
      detailsHtml += '<div class="details"><div><span class="detail-label">Last Verified:</span> ' + tags.check_date + '</div></div>';

    return '<div class="fountain-popup">' +
      detailsHtml +
      buildRatingSection("osm", String(el.id), false) +
      buildAttributeSection(local, tags.wheelchair === "yes") +
      '<div class="popup-footer">' +
        (title ? '<div class="popup-name">' + title + '</div>' : '') +
        '<div class="popup-source">OpenStreetMap</div>' +
      '</div>' +
    '</div>';
  }

  function getPinZIndex(sourceType, sourceId) {
    var state = getPinStateForFountain(sourceType, sourceId);
    if (state === "unrated" && !isReportedOff(sourceType, sourceId)) return 0;
    return 1000;
  }

  function pinStateToIcon(state, color) {
    if (state === "up")     return makeIcon(color, THUMB_UP);
    if (state === "down")   return makeIcon(color, THUMB_DOWN);
    if (state === "unrated") return makeIcon("#9e9e9e", QUESTION_ICON);
    return makeIcon(color, QUESTION_ICON);
  }

  function getCityIcon(f) {
    if (!isCityRunning(f)) return icons.cityOff;
    if (isReportedOff("city_gis", String(f.OBJECTID))) return icons.reportedOff;
    return pinStateToIcon(getPinStateForFountain("city_gis", String(f.OBJECTID)), "#2563eb");
  }

  function getOsmIcon(el) {
    if (isReportedOff("osm", String(el.id))) return icons.reportedOff;
    var color = powerUserMode ? "#0891b2" : "#2563eb";
    return pinStateToIcon(getPinStateForFountain("osm", String(el.id)), color);
  }

  function renderCity() {
    sources.city.layerGroup.clearLayers();
    sources.city.data.forEach(function (f) {
      if (f.LIFE_CYCLE_CODE !== "A") return;
      if (activeFilters.accessible && !fountainHasAccessible("city_gis", String(f.OBJECTID), f)) return;
      if (activeFilters.bottle && !fountainHasBottle("city_gis", String(f.OBJECTID), f)) return;
      if (activeFilters.dog && !fountainHasDog("city_gis", String(f.OBJECTID), f)) return;
      if (layerOptions.cityUniqueOnly && cityHasOsmMatch(f)) return;
      if (!passesRatingFilter("city_gis", String(f.OBJECTID))) return;

      var cm = L.marker([f.LATITUDE, f.LONGITUDE], { icon: getCityIcon(f), zIndexOffset: getPinZIndex("city_gis", String(f.OBJECTID)) });
      cm._fountainData = f;
      cm.bindPopup(function () { return buildCityPopup(f); }).addTo(sources.city.layerGroup);
    });
  }

  function renderOsm() {
    sources.osm.layerGroup.clearLayers();
    sources.osm.data.forEach(function (el) {
      var tags = el.tags || {};
      if (!powerUserMode) {
        var local = lookupFountain("osm", String(el.id));
        if (local && (local.sources || []).some(function (s) { return s.source_type === "city_gis"; })) return;
      }
      if (activeFilters.accessible && !fountainHasAccessible("osm", String(el.id), el)) return;
      if (activeFilters.bottle && !fountainHasBottle("osm", String(el.id), el)) return;
      if (activeFilters.dog && !fountainHasDog("osm", String(el.id), el)) return;
      if (!passesRatingFilter("osm", String(el.id))) return;

      var om = L.marker([el.lat, el.lon], { icon: getOsmIcon(el), zIndexOffset: getPinZIndex("osm", String(el.id)) });
      om._fountainData = el;
      om.bindPopup(function () { return buildOsmPopup(el); }).addTo(sources.osm.layerGroup);
    });
  }

  function renderAll() {
    renderCity();
    renderOsm();
    updateCount();
  }

  function updateMarkerForFountain(fountainId) {
    sources.city.layerGroup.eachLayer(function (marker) {
      var f = marker._fountainData;
      if (!f) return;
      var local = lookupFountain("city_gis", String(f.OBJECTID));
      if (!local || local.id !== fountainId) return;
      marker.setIcon(getCityIcon(f));
      marker.setZIndexOffset(getPinZIndex("city_gis", String(f.OBJECTID)));
    });
    sources.osm.layerGroup.eachLayer(function (marker) {
      var el = marker._fountainData;
      if (!el) return;
      var local = lookupFountain("osm", String(el.id));
      if (!local || local.id !== fountainId) return;
      marker.setIcon(getOsmIcon(el));
      marker.setZIndexOffset(getPinZIndex("osm", String(el.id)));
    });
  }

  function updateCount() {
    var bounds = map.getBounds();
    var count = 0;
    Object.values(sources).forEach(function (src) {
      if (!src.visible) return;
      src.layerGroup.eachLayer(function (marker) {
        if (bounds.contains(marker.getLatLng())) count++;
      });
    });
    var el = document.getElementById("fountain-count");
    el.textContent = count + " fountain" + (count !== 1 ? "s" : "") + " in view";
  }

  function fetchFountainIndex() {
    if (!API_BASE) return;
    fetch(API_BASE + "/fountains")
      .then(function (res) { return res.json(); })
      .then(function (data) {
        fountainIndex = {};
        (data.fountains || []).forEach(function (f) {
          (f.sources || []).forEach(function (s) {
            fountainIndex[s.source_type + ":" + s.source_id] = f;
          });
        });
        fountainIndexLoaded = true;
        updateRatingCounts();
        renderAll();
      })
      .catch(function (err) {
        console.error("Failed to fetch fountain index:", err);
      });
  }

  function fetchCity() {
    var params = new URLSearchParams({
      where: "1=1",
      outFields: [
        "OBJECTID", "PARK", "ACCESSIBLE_MODEL", "CURRENT_STATUS",
        "REASON_OFF", "LATITUDE", "LONGITUDE", "LIFE_CYCLE_CODE",
        "BOTTLE_FILLER", "DOG_BOWL",
      ].join(","),
      f: "json",
      resultRecordCount: 2000,
    });

    fetch(ARCGIS_URL + "?" + params)
      .then(function (res) { return res.json(); })
      .then(function (data) {
        if (!data.features) return;
        sources.city.data = data.features.map(function (f) { return f.attributes; });
        renderCity();
        updateCount();
      })
      .catch(function (err) { console.error("Failed to fetch City GIS data:", err); });
  }

  function fetchOsm() {
    var query = '[out:json];node[amenity=drinking_water](' + SEATTLE_BOUNDS + ');out body;';
    fetch(OVERPASS_URL, { method: "POST", body: query })
      .then(function (res) { return res.json(); })
      .then(function (data) {
        sources.osm.data = data.elements || [];
        renderOsm();
        if (layerOptions.cityUniqueOnly) renderCity();
        updateCount();
      })
      .catch(function (err) { console.error("Failed to fetch OSM data:", err); });
  }

  function submitAttribute(fountainId, attribute, value) {
    if (!API_BASE) return;
    fetch(API_BASE + "/fountains/" + fountainId + "/attributes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ device_id: deviceId, attribute: attribute, value: value }),
    })
      .then(function (res) { return res.json(); })
      .then(function (data) {
        if (data.error) {
          showError("Update failed: " + data.error);
          return;
        }
        Object.keys(fountainIndex).forEach(function (key) {
          if (fountainIndex[key].id === fountainId) {
            fountainIndex[key].user_accessible = data.user_accessible;
            fountainIndex[key].user_bottle_filler = data.user_bottle_filler;
            fountainIndex[key].user_dog_bowl = data.user_dog_bowl;
          }
        });
      })
      .catch(function () {
        showError("Failed to update attribute. Please try again.");
      });
  }

  function submitReport(fountainId, status) {
    if (!API_BASE) return;
    fetch(API_BASE + "/fountains/" + fountainId + "/report", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ device_id: deviceId, status: status }),
    })
      .then(function (res) { return res.json(); })
      .then(function (data) {
        if (data.error) {
          showError("Report failed: " + data.error);
          return;
        }
        Object.keys(fountainIndex).forEach(function (key) {
          if (fountainIndex[key].id === fountainId) {
            fountainIndex[key].reported_off = data.reported_off;
            fountainIndex[key].off_reports = data.off_reports;
            fountainIndex[key].last_off_report_at = data.last_off_report_at;
          }
        });
        map.closePopup();
        renderAll();
      })
      .catch(function () {
        showError("Failed to submit report. Please try again.");
      });
  }

  function submitRating(fountainId, score) {
    if (!API_BASE) return;
    var isUnrating = myRatings[fountainId] === score;
    var method = isUnrating ? "DELETE" : "POST";
    fetch(API_BASE + "/fountains/" + fountainId + "/rating", {
      method: method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ device_id: deviceId, score: score }),
    })
      .then(function (res) { return res.json(); })
      .then(function (data) {
        if (data.error) {
          showError("Rating failed: " + data.error);
          return;
        }
        myRatings[fountainId] = isUnrating ? null : score;
        Object.keys(fountainIndex).forEach(function (key) {
          if (fountainIndex[key].id === fountainId) {
            fountainIndex[key].thumbs_up = data.thumbs_up;
            fountainIndex[key].thumbs_down = data.thumbs_down;
            fountainIndex[key].rating_count = data.rating_count;
            fountainIndex[key].last_rated_at = data.last_rated_at;
          }
        });
        updateOpenPopupRating(fountainId, data);
        updateMarkerForFountain(fountainId);
      })
      .catch(function () {
        showError("Failed to submit rating. Please try again.");
      });
  }

  function updateOpenPopupRating(fountainId, data) {
    var section = document.querySelector('.rating-section[data-fountain-id="' + fountainId + '"]');
    if (!section) return;

    var reactions = section.querySelector(".reactions");
    if (reactions) {
      reactions.outerHTML = buildReactionButtons(fountainId, data.thumbs_up, data.thumbs_down, data.your_score);
      // re-attach listeners after DOM replacement
      section.querySelectorAll(".reaction-btn").forEach(function (btn) {
        btn.addEventListener("click", function () {
          submitRating(parseInt(this.dataset.fountainId), parseInt(this.dataset.score));
        });
      });
    }

    var lastEl = section.querySelector(".rating-last");
    if (lastEl) {
      lastEl.textContent = "Last rated " + formatRelativeDate(data.last_rated_at);
    } else {
      var newLast = document.createElement("div");
      newLast.className = "rating-last";
      newLast.textContent = "Last rated " + formatRelativeDate(data.last_rated_at);
      section.querySelector(".reactions")
        ? section.querySelector(".reactions").insertAdjacentElement("afterend", newLast)
        : section.insertAdjacentElement("afterbegin", newLast);
    }
  }

  map.on("popupopen", function (e) {
    var container = e.popup.getElement();
    if (!container) return;
    container.querySelectorAll(".reaction-btn").forEach(function (btn) {
      btn.addEventListener("click", function () {
        submitRating(parseInt(this.dataset.fountainId), parseInt(this.dataset.score));
      });
    });
    container.querySelectorAll(".report-btn").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var fId = parseInt(this.dataset.fountainId);
        var status = this.dataset.status;
        if (status === "off") {
          showConfirm("Report this fountain as turned off?", function () { submitReport(fId, status); });
          return;
        }
        submitReport(fId, status);
      });
    });
    container.querySelectorAll(".attr-checkbox:not([disabled])").forEach(function (cb) {
      cb.addEventListener("change", function () {
        var fId = parseInt(this.dataset.fountainId);
        var attr = this.dataset.attribute;
        submitAttribute(fId, attr, this.checked);
      });
    });
    container.querySelectorAll(".attr-tooltip-btn").forEach(function (btn) {
      var tip = null;
      btn.addEventListener("click", function (e) {
        e.stopPropagation();
        if (tip) { tip.remove(); tip = null; return; }
        tip = document.createElement("div");
        tip.className = "attr-tooltip";
        tip.textContent = btn.dataset.tooltip;
        btn.insertAdjacentElement("afterend", tip);
        document.addEventListener("click", function dismiss() {
          if (tip) { tip.remove(); tip = null; }
          document.removeEventListener("click", dismiss);
        });
      });
    });
  });

  function searchLocation(query) {
    var params = new URLSearchParams({
      q: query,
      format: "json",
      addressdetails: "1",
      limit: "1",
      viewbox: "-122.45,47.48,-122.24,47.73",
      bounded: "1",
    });

    return fetch(NOMINATIM_URL + "?" + params, {
      headers: { "Accept": "application/json" },
    })
      .then(function (res) { return res.json(); })
      .then(function (results) {
        if (results.length === 0) return null;
        return {
          lat: parseFloat(results[0].lat),
          lon: parseFloat(results[0].lon),
        };
      });
  }

  function showError(msg) {
    var existing = document.querySelector(".search-error");
    if (existing) existing.remove();

    var el = document.createElement("div");
    el.className = "search-error";
    el.textContent = msg;
    document.body.appendChild(el);
    setTimeout(function () { el.remove(); }, 3000);
  }

  function panToLocation(lat, lon) {
    map.setView([lat, lon], SEARCH_ZOOM);
    if (userMarker) map.removeLayer(userMarker);
    userMarker = L.circleMarker([lat, lon], {
      radius: 8,
      fillColor: "#4285f4",
      fillOpacity: 1,
      color: "#fff",
      weight: 2,
    }).addTo(map);
  }

  document.getElementById("search-form").addEventListener("submit", function (e) {
    e.preventDefault();
    var query = document.getElementById("search-input").value.trim();
    if (!query) return;
    document.getElementById("search-input").blur();
    searchLocation(query).then(function (result) {
      if (!result) {
        showError("No results found in Seattle. Try a different search.");
        return;
      }
      panToLocation(result.lat, result.lon);
    }).catch(function () {
      showError("Search failed. Please try again.");
    });
  });

  var locateBtn = document.getElementById("locate-btn");
  var locating = false;

  function preloadLocation() {
    if (!navigator.geolocation) return;
    navigator.geolocation.getCurrentPosition(
      function (pos) { cachedPosition = pos; },
      function (err) { if (err.code === 1) locationDenied = true; },
      { enableHighAccuracy: false, timeout: 10000, maximumAge: 60000 }
    );
  }

  function locateUser() {
    if (locating) return;
    if (!navigator.geolocation) {
      showError("Geolocation is not supported by your browser.");
      return;
    }
    if (locationDenied) {
      showError("Location access denied. Check your browser or device settings.");
      return;
    }
    var cacheAgeSec = cachedPosition
      ? (Date.now() - cachedPosition.timestamp) / 1000
      : Infinity;
    if (cacheAgeSec < 60) {
      panToLocation(cachedPosition.coords.latitude, cachedPosition.coords.longitude);
      return;
    }
    locating = true;
    locateBtn.classList.add("locating");

    var watchId = navigator.geolocation.watchPosition(
      function (pos) {
        navigator.geolocation.clearWatch(watchId);
        locating = false;
        locateBtn.classList.remove("locating");
        cachedPosition = pos;
        panToLocation(pos.coords.latitude, pos.coords.longitude);
      },
      function (err) {
        navigator.geolocation.clearWatch(watchId);
        locating = false;
        locateBtn.classList.remove("locating");
        if (err.code === 1) {
          locationDenied = true;
          showError("Location access denied. Check your browser or device settings.");
        } else {
          showError("Unable to get your location. Try again.");
        }
      },
      { enableHighAccuracy: true, timeout: 20000, maximumAge: 30000 }
    );
  }

  locateBtn.addEventListener("click", locateUser);

  var filterBtn = document.getElementById("filter-btn");
  var filterPanel = document.getElementById("filter-panel");

  filterBtn.addEventListener("click", function (e) {
    e.stopPropagation();
    filterPanel.classList.toggle("collapsed");
  });

  document.addEventListener("click", function (e) {
    if (!filterPanel.classList.contains("collapsed") &&
        !document.getElementById("filter-dropdown").contains(e.target)) {
      filterPanel.classList.add("collapsed");
    }
  });

  var filterCount = document.getElementById("filter-count");

  function updateFilterBtn() {
    var count = Object.values(activeFilters).filter(Boolean).length;
    filterBtn.classList.toggle("has-active", count > 0);
    filterCount.textContent = count;
    filterCount.classList.toggle("hidden", count === 0);
  }

  document.querySelectorAll(".filter-toggle").forEach(function (btn) {
    btn.addEventListener("click", function () {
      var filter = btn.dataset.filter;
      activeFilters[filter] = !activeFilters[filter];
      btn.classList.toggle("active");
      updateFilterBtn();
      renderAll();
    });
  });

  var powerUserBtn = document.getElementById("power-user-btn");
  var layerControl = document.getElementById("layer-control");
  var legendAdminRow = document.querySelector(".legend-admin-row");
  var confirmModal = document.getElementById("confirm-modal");
  var confirmMessage = document.getElementById("confirm-message");
  var confirmOkBtn = document.getElementById("confirm-ok-btn");
  var confirmCancelBtn = document.getElementById("confirm-cancel-btn");
  var confirmCallback = null;

  function showConfirm(message, onConfirm) {
    confirmMessage.textContent = message;
    confirmCallback = onConfirm;
    confirmModal.classList.remove("hidden");
  }

  function closeConfirm() {
    confirmModal.classList.add("hidden");
    confirmCallback = null;
  }

  confirmOkBtn.addEventListener("click", function () {
    var cb = confirmCallback;
    closeConfirm();
    if (cb) cb();
  });
  confirmCancelBtn.addEventListener("click", closeConfirm);
  confirmModal.addEventListener("click", function (e) {
    if (e.target === confirmModal) closeConfirm();
  });

  var pinModal = document.getElementById("pin-modal");
  var pinInput = document.getElementById("pin-input");
  var pinError = document.getElementById("pin-error");
  var pinSubmitBtn = document.getElementById("pin-submit-btn");
  var pinCancelBtn = document.getElementById("pin-cancel-btn");

  var ADMIN_SESSION_KEY = "admin_unlocked";

  function isAdminUnlocked() {
    return sessionStorage.getItem(ADMIN_SESSION_KEY) === "1";
  }

  function activateAdminMode() {
    powerUserMode = true;
    powerUserBtn.classList.add("active");
    layerControl.classList.remove("hidden");
    legendAdminRow.classList.remove("hidden");
    updateRatingCounts();
    renderAll();
  }

  function deactivateAdminMode() {
    powerUserMode = false;
    powerUserBtn.classList.remove("active");
    layerControl.classList.add("hidden");
    legendAdminRow.classList.add("hidden");
    if (layerOptions.ratingFilter) {
      layerOptions.ratingFilter = null;
      ratedBtn.classList.remove("active");
      unratedBtn.classList.remove("active");
    }
    renderAll();
  }

  function openPinModal() {
    pinInput.value = "";
    pinError.classList.add("hidden");
    pinModal.classList.remove("hidden");
    pinInput.focus();
  }

  function closePinModal() {
    pinModal.classList.add("hidden");
    pinInput.value = "";
    pinError.classList.add("hidden");
  }

  function submitPin() {
    var pin = pinInput.value.trim();
    if (!pin) return;
    pinSubmitBtn.disabled = true;
    pinSubmitBtn.textContent = "Checking…";
    fetch(API_BASE + "/admin/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pin: pin }),
    })
      .then(function (res) { return res.json().then(function (d) { return { ok: res.ok, data: d }; }); })
      .then(function (r) {
        pinSubmitBtn.disabled = false;
        pinSubmitBtn.textContent = "Unlock";
        if (r.ok) {
          sessionStorage.setItem(ADMIN_SESSION_KEY, "1");
          closePinModal();
          activateAdminMode();
        } else {
          pinError.classList.remove("hidden");
          pinInput.value = "";
          pinInput.focus();
        }
      })
      .catch(function () {
        pinSubmitBtn.disabled = false;
        pinSubmitBtn.textContent = "Unlock";
        pinError.textContent = "Request failed. Try again.";
        pinError.classList.remove("hidden");
      });
  }

  powerUserBtn.addEventListener("click", function () {
    if (powerUserMode) {
      deactivateAdminMode();
      return;
    }
    if (isAdminUnlocked()) {
      activateAdminMode();
      return;
    }
    openPinModal();
  });

  pinSubmitBtn.addEventListener("click", submitPin);
  pinCancelBtn.addEventListener("click", closePinModal);
  pinInput.addEventListener("keydown", function (e) {
    if (e.key === "Enter") submitPin();
    if (e.key === "Escape") closePinModal();
  });
  pinModal.addEventListener("click", function (e) {
    if (e.target === pinModal) closePinModal();
  });

  var legendEl = document.getElementById("legend");
  var legendToggle = document.getElementById("legend-toggle");
  var legendBody = document.getElementById("legend-body");

  legendEl.addEventListener("click", function () {
    var collapsed = legendBody.classList.toggle("collapsed");
    legendToggle.textContent = collapsed ? "▸" : "▾";
  });

  var cityUniqueBtn = document.querySelector('.layer-suboption[data-option="city-unique"]');
  var ratedBtn = document.querySelector('.layer-suboption[data-option="rated"]');
  var unratedBtn = document.querySelector('.layer-suboption[data-option="unrated"]');
  var countRatedEl = document.getElementById("count-rated");
  var countUnratedEl = document.getElementById("count-unrated");

  function updateRatingCounts() {
    if (!fountainIndexLoaded) return;
    var seen = {};
    var rated = 0, unrated = 0;
    Object.values(fountainIndex).forEach(function (f) {
      if (seen[f.id]) return;
      seen[f.id] = true;
      if (f.rating_count > 0) rated++; else unrated++;
    });
    countRatedEl.textContent = rated;
    countUnratedEl.textContent = unrated;
  }

  function setRatingFilter(option) {
    if (layerOptions.ratingFilter === option) {
      layerOptions.ratingFilter = null;
      ratedBtn.classList.remove("active");
      unratedBtn.classList.remove("active");
    } else {
      layerOptions.ratingFilter = option;
      ratedBtn.classList.toggle("active", option === "rated");
      unratedBtn.classList.toggle("active", option === "unrated");
    }
    renderAll();
  }

  ratedBtn.addEventListener("click", function () { setRatingFilter("rated"); });
  unratedBtn.addEventListener("click", function () { setRatingFilter("unrated"); });

  document.querySelectorAll(".layer-toggle").forEach(function (btn) {
    btn.addEventListener("click", function () {
      var source = btn.dataset.source;
      var src = sources[source];
      src.visible = !src.visible;
      btn.classList.toggle("active");
      if (src.visible) {
        src.layerGroup.addTo(map);
      } else {
        map.removeLayer(src.layerGroup);
      }
      if (source === "city") {
        cityUniqueBtn.classList.toggle("hidden", !src.visible);
      }
      updateCount();
    });
  });

  cityUniqueBtn.addEventListener("click", function () {
    layerOptions.cityUniqueOnly = !layerOptions.cityUniqueOnly;
    cityUniqueBtn.classList.toggle("active");
    renderCity();
    updateCount();
  });

  map.on("moveend", updateCount);

  map.on("click", function () {
    filterPanel.classList.add("collapsed");
    legendBody.classList.add("collapsed");
    legendToggle.textContent = "▸";
  });

  fetchCity();
  fetchOsm();
  fetchFountainIndex();
  preloadLocation();
})();
