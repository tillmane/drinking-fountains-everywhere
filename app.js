(function () {
  "use strict";

  var API_BASE = "https://drinking-fountains-api.urbanfreerunners.com";

  var NOMINATIM_URL = "https://nominatim.openstreetmap.org/search";
  var SEATTLE_CENTER = [47.6062, -122.3321];
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
  var myNotFoundReports = {}; // fountainId -> true
  var adminPin = null;
  var pilotMode = false;
  var pilotToken = null;
  var REQUEST_ACCESS_URL = 'https://docs.google.com/forms/d/e/1FAIpQLSct5j7wwDKQetU40e9zEkbe-7Y6GoZ4iV6cPy2ZmP09iH-NgA/viewform?usp=publish-editor';

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
    city: { layerGroup: L.layerGroup().addTo(map), visible: true },
    osm:  { layerGroup: L.layerGroup().addTo(map), visible: true },
  };

  var layerOptions = {
    cityUniqueOnly: false,
    ratingFilter: null, // null | "rated" | "unrated"
    showNotFound: false,
  };

  function isYes(val) {
    return typeof val === "string" && val.toUpperCase() === "YES";
  }

  function isCityRunning(sd) {
    return sd.CURRENT_STATUS === "ON" || sd.CURRENT_STATUS === null || sd.CURRENT_STATUS === undefined;
  }

  function getSourceData(local, sourceType) {
    var src = (local.sources || []).find(function (s) { return s.source_type === sourceType && s.source_data !== null; });
    return src ? src.source_data : null;
  }

  function fountainHasOsmMatch(local) {
    return (local.sources || []).some(function (s) { return s.source_type === "osm" && s.source_data !== null; });
  }

  function fountainHasCityGisMatch(local) {
    return (local.sources || []).some(function (s) { return s.source_type === "city_gis" && s.source_data !== null; });
  }

  function fountainHasAccessible(local) {
    if (local.user_accessible) return true;
    var city = getSourceData(local, "city_gis");
    if (city) return isYes(city.ACCESSIBLE_MODEL);
    var osm = getSourceData(local, "osm");
    if (osm) return (osm.tags || {}).wheelchair === "yes";
    return false;
  }

  function fountainHasBottle(local) {
    if (local.user_bottle_filler) return true;
    var city = getSourceData(local, "city_gis");
    if (city) return isYes(city.BOTTLE_FILLER);
    var osm = getSourceData(local, "osm");
    if (osm) return (osm.tags || {}).bottle === "yes";
    return false;
  }

  function fountainHasDog(local) {
    if (local.user_dog_bowl) return true;
    var city = getSourceData(local, "city_gis");
    if (city) return isYes(city.DOG_BOWL);
    var osm = getSourceData(local, "osm");
    if (osm) return (osm.tags || {}).dog === "yes";
    return false;
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
    cityOff:        makeIcon("#c62828", X_ICON),
    reportedOff:    makeIcon("#e67e22", X_ICON),
    reportedNotFound: makeIcon("#e67e22", QUESTION_ICON),
  };

  function lookupFountain(sourceType, sourceId) {
    return fountainIndex[sourceType + ":" + sourceId] || null;
  }

  function getPinStateForLocal(local) {
    if (!fountainIndexLoaded || !local || !local.rating_count) return "unrated";
    if (local.thumbs_down > local.thumbs_up) return "down";
    return "up";
  }

  function passesRatingFilter(local) {
    if (!layerOptions.ratingFilter) return true;
    var rated = local && local.rating_count > 0;
    return layerOptions.ratingFilter === "rated" ? rated : !rated;
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
      '<div class="reaction-row">' +
        '<button class="reaction-btn' + upActive + '" data-fountain-id="' + fountainId + '" data-score="1">👍 <span class="reaction-count">' + (thumbsUp || 0) + '</span></button>' +
        '<div class="reaction-label">Good water — reliable, clean, decent pressure</div>' +
      '</div>' +
      '<div class="reaction-row">' +
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
    if (!pilotMode) {
      var parts = [];
      if (sourceAccessible || local.user_accessible) parts.push("Accessible");
      if (local.user_bottle_filler) parts.push("Bottle Filler");
      if (local.user_dog_bowl) parts.push("Dog Bowl");
      if (parts.length === 0) return "";
      return '<div class="attr-section attr-section-readonly"><span class="attr-readonly-label">' + parts.join(" · ") + '</span></div>';
    }
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

  function buildReportSection(local) {
    if (!local) return "";
    if (!pilotMode) return "";

    var anyNfReport = local.not_found_count > 0;
    var myNfReport = !!myNotFoundReports[local.id];
    var thresholdReached = local.not_found;

    // When threshold is reached, only admin can see/act — all report controls hidden for regular users
    if (thresholdReached && !powerUserMode) {
      return '<div class="report-section">' +
        '<div class="report-actions">' +
          '<button class="report-btn reinstate-btn" data-fountain-id="' + local.id + '" style="display:none">Reinstate</button>' +
        '</div>' +
      '</div>';
    }

    var offHtml = "";
    // Report Off is hidden if any not-found report exists (not-found overrides)
    if (!anyNfReport) {
      if (local.reported_off) {
        offHtml = '<div class="report-status reported-off">Reported off (' + local.off_reports + ') as of ' + formatRelativeDate(local.last_off_report_at) + '</div>' +
          '<button class="report-btn report-on-btn" data-fountain-id="' + local.id + '" data-status="on">Report on</button>';
      } else {
        offHtml = '<button class="report-btn report-off-btn" data-fountain-id="' + local.id + '" data-status="off">Report off</button>';
      }
    }

    var nfHtml = "";
    if (powerUserMode && thresholdReached) {
      nfHtml = '<button class="report-btn reinstate-btn" data-fountain-id="' + local.id + '">Reinstate</button>';
    } else if (myNfReport) {
      nfHtml = '<div class="report-status not-found-status">Reported not found as of ' + formatRelativeDate(local.last_not_found_at) + '</div>' +
        '<button class="report-btn undo-not-found-btn" data-fountain-id="' + local.id + '">Undo Not Found</button>';
    } else if (anyNfReport) {
      nfHtml = '<div class="report-status not-found-status">Reported not found (' + local.not_found_count + ')</div>' +
        '<button class="report-btn confirm-not-found-btn" data-fountain-id="' + local.id + '">Confirm Not Found</button>';
    } else {
      nfHtml = '<button class="report-btn not-found-btn" data-fountain-id="' + local.id + '">Not Found</button>';
    }

    return '<div class="report-section">' +
      '<div class="report-actions">' + offHtml + nfHtml + '</div>' +
    '</div>';
  }

  function buildRatingSection(local, sourceOff) {
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

    if (!pilotMode) {
      var ratingsSummary = (local.rating_count > 0)
        ? '<div class="rating-summary">' +
            '<span class="rating-summary-item">👍 ' + (local.thumbs_up || 0) + '</span>' +
            '<span class="rating-summary-item">👎 ' + (local.thumbs_down || 0) + '</span>' +
            (local.last_rated_at ? '<span class="rating-last">Last rated ' + formatRelativeDate(local.last_rated_at) + '</span>' : '') +
          '</div>'
        : '<p class="rating-unavailable">Not yet rated</p>';
      return '<div class="rating-section" data-fountain-id="' + local.id + '">' +
        ratingsSummary +
        '<p class="rating-request-access"><a href="' + REQUEST_ACCESS_URL + '" target="_blank" rel="noopener">Request pilot access</a> to rate this fountain.</p>' +
      '</div>';
    }

    var lastRated = local.last_rated_at
      ? "Last rated " + formatRelativeDate(local.last_rated_at)
      : "";

    return '<div class="rating-section" data-fountain-id="' + local.id + '">' +
      buildReactionButtons(local.id, local.thumbs_up, local.thumbs_down, myRatings[local.id] !== undefined ? myRatings[local.id] : null) +
      (lastRated ? '<div class="rating-last">' + lastRated + '</div>' : '') +
    '</div>';
  }

  function buildPopup(local) {
    if (!local) return '<div class="fountain-popup"><p>Data unavailable</p></div>';

    var citySD = getSourceData(local, "city_gis");
    var osmSD = getSourceData(local, "osm");
    var tags = osmSD ? osmSD.tags || {} : {};

    var running = citySD ? isCityRunning(citySD) : true;
    var sourceLabel = citySD ? "Seattle City GIS" : "OpenStreetMap";

    var title = (citySD && citySD.PARK) || null;
    if (!title && tags.name && tags.name !== "Drinking Fountain") title = tags.name;

    var detailsHtml = "";
    if (citySD && !running)
      detailsHtml += '<div class="details"><div><span class="detail-label">Reason Off:</span> ' + (citySD.REASON_OFF || "UNKNOWN") + '</div></div>';
    if (!citySD && tags.check_date)
      detailsHtml += '<div class="details"><div><span class="detail-label">Last Verified:</span> ' + tags.check_date + '</div></div>';

    var sourceAccessible = citySD ? isYes(citySD.ACCESSIBLE_MODEL) : tags.wheelchair === "yes";

    return '<div class="fountain-popup">' +
      (citySD && !running ? '<span class="status off">Shut Off</span>' : '') +
      detailsHtml +
      buildRatingSection(local, !running) +
      buildAttributeSection(local, sourceAccessible) +
      buildReportSection(local) +
      '<div class="popup-footer">' +
        (title ? '<div class="popup-name">' + title + '</div>' : '') +
        '<div class="popup-source">' + sourceLabel + '</div>' +
      '</div>' +
    '</div>';
  }

  function getPinZIndex(local) {
    var state = getPinStateForLocal(local);
    if (state === "unrated" && !(local && local.reported_off)) return 0;
    return 1000;
  }

  function pinStateToIcon(state, color) {
    if (state === "up")     return makeIcon(color, THUMB_UP);
    if (state === "down")   return makeIcon(color, THUMB_DOWN);
    if (state === "unrated") return makeIcon("#9e9e9e", QUESTION_ICON);
    return makeIcon(color, QUESTION_ICON);
  }

  function isReportedNotFound(local) {
    return local && local.not_found_count > 0;
  }

  function getCityIcon(local, sd) {
    if (sd && !isCityRunning(sd)) return icons.cityOff;
    if (isReportedNotFound(local)) return icons.reportedNotFound;
    if (local && local.reported_off) return icons.reportedOff;
    return pinStateToIcon(getPinStateForLocal(local), "#2563eb");
  }

  function getOsmIcon(local) {
    if (isReportedNotFound(local)) return icons.reportedNotFound;
    if (local && local.reported_off) return icons.reportedOff;
    var color = powerUserMode ? "#0891b2" : "#2563eb";
    return pinStateToIcon(getPinStateForLocal(local), color);
  }

  // fountainList is an array of fountain records from GET /fountains,
  // each having .id, .lat, .lon, .sources (with source_data), ratings, etc.
  var fountainList = [];

  function renderCity() {
    sources.city.layerGroup.clearLayers();
    fountainList.forEach(function (local) {
      var citySD = getSourceData(local, "city_gis");
      if (!citySD) return;
      if (layerOptions.cityUniqueOnly && fountainHasOsmMatch(local)) return;
      if (activeFilters.accessible && !fountainHasAccessible(local)) return;
      if (activeFilters.bottle && !fountainHasBottle(local)) return;
      if (activeFilters.dog && !fountainHasDog(local)) return;
      if (!passesRatingFilter(local)) return;
      if (layerOptions.showNotFound) {
        if (!local.not_found) return;
      } else if (local.not_found) return;

      var icon = layerOptions.showNotFound ? icons.reportedNotFound : getCityIcon(local, citySD);
      var cm = L.marker([local.lat, local.lon], { icon: icon, zIndexOffset: getPinZIndex(local) });
      cm._fountainId = local.id;
      cm.bindPopup(function () { return buildPopup(local); }).addTo(sources.city.layerGroup);
    });
  }

  function renderOsm() {
    sources.osm.layerGroup.clearLayers();
    fountainList.forEach(function (local) {
      var osmSD = getSourceData(local, "osm");
      if (!osmSD) return;
      if (!powerUserMode && fountainHasCityGisMatch(local)) return;
      if (activeFilters.accessible && !fountainHasAccessible(local)) return;
      if (activeFilters.bottle && !fountainHasBottle(local)) return;
      if (activeFilters.dog && !fountainHasDog(local)) return;
      if (!passesRatingFilter(local)) return;
      if (layerOptions.showNotFound) {
        if (!local.not_found) return;
      } else if (local.not_found) return;

      var icon = layerOptions.showNotFound ? icons.reportedNotFound : getOsmIcon(local);
      var om = L.marker([local.lat, local.lon], { icon: icon, zIndexOffset: getPinZIndex(local) });
      om._fountainId = local.id;
      om.bindPopup(function () { return buildPopup(local); }).addTo(sources.osm.layerGroup);
    });
  }

  function renderAll() {
    renderCity();
    renderOsm();
    updateCount();
  }

  function updateMarkerForFountain(fountainId) {
    var local = fountainIndex[fountainId];
    if (!local) return;
    var hasCityGis = fountainHasCityGisMatch(local);
    var hasOsm = (getSourceData(local, "osm") !== null);
    if (hasCityGis) {
      sources.city.layerGroup.eachLayer(function (marker) {
        if (marker._fountainId !== fountainId) return;
        marker.setIcon(getCityIcon(local, getSourceData(local, "city_gis")));
        marker.setZIndexOffset(getPinZIndex(local));
      });
    }
    if (hasOsm) {
      sources.osm.layerGroup.eachLayer(function (marker) {
        if (marker._fountainId !== fountainId) return;
        marker.setIcon(getOsmIcon(local));
        marker.setZIndexOffset(getPinZIndex(local));
      });
    }
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

  function fetchFountains() {
    if (!API_BASE) return;
    fetch(API_BASE + "/fountains")
      .then(function (res) { return res.json(); })
      .then(function (data) {
        fountainIndex = {};
        fountainList = data.fountains || [];
        fountainList.forEach(function (f) {
          fountainIndex[f.id] = f;
          (f.sources || []).forEach(function (s) {
            fountainIndex[s.source_type + ":" + s.source_id] = f;
          });
        });
        fountainIndexLoaded = true;
        updateRatingCounts();
        updateNotFoundCount();
        renderAll();
      })
      .catch(function (err) {
        console.error("Failed to fetch fountains:", err);
      });
  }

  function pilotHeaders() {
    var h = { "Content-Type": "application/json" };
    if (pilotToken) h["X-Pilot-Token"] = pilotToken;
    return h;
  }

  function handlePilotUnauthorized() {
    showError("Pilot session expired. Please re-enter your pilot code.");
    deactivatePilotMode();
  }

  function submitAttribute(fountainId, attribute, value) {
    if (!API_BASE) return;
    fetch(API_BASE + "/fountains/" + fountainId + "/attributes", {
      method: "POST",
      headers: pilotHeaders(),
      body: JSON.stringify({ device_id: deviceId, attribute: attribute, value: value }),
    })
      .then(function (res) {
        if (res.status === 401) { handlePilotUnauthorized(); return null; }
        return res.json();
      })
      .then(function (data) {
        if (!data) return;
        if (data.error) {
          showError("Update failed: " + data.error);
          return;
        }
        var f = fountainIndex[fountainId];
        if (f) {
          f.user_accessible = data.user_accessible;
          f.user_bottle_filler = data.user_bottle_filler;
          f.user_dog_bowl = data.user_dog_bowl;
        }
      })
      .catch(function () {
        showError("Failed to update attribute. Please try again.");
      });
  }

  function submitReport(fountainId, status) {
    if (!API_BASE) return;
    fetch(API_BASE + "/fountains/" + fountainId + "/report", {
      method: "POST",
      headers: pilotHeaders(),
      body: JSON.stringify({ device_id: deviceId, status: status }),
    })
      .then(function (res) {
        if (res.status === 401) { handlePilotUnauthorized(); return null; }
        return res.json();
      })
      .then(function (data) {
        if (!data) return;
        if (data.error) {
          showError("Report failed: " + data.error);
          return;
        }
        var f = fountainIndex[fountainId];
        if (f) {
          f.reported_off = data.reported_off;
          f.off_reports = data.off_reports;
          f.last_off_report_at = data.last_off_report_at;
        }
        map.closePopup();
        renderAll();
      })
      .catch(function () {
        showError("Failed to submit report. Please try again.");
      });
  }

  function submitNotFound(fountainId, adminToken) {
    if (!API_BASE) return;
    var isUndo = !adminToken && myNotFoundReports[fountainId];
    var method = (isUndo || adminToken) ? "DELETE" : "POST";
    var body = adminToken
      ? { admin_token: adminToken }
      : { device_id: deviceId };
    var headers = adminToken ? { "Content-Type": "application/json" } : pilotHeaders();
    fetch(API_BASE + "/fountains/" + fountainId + "/not-found", {
      method: method,
      headers: headers,
      body: JSON.stringify(body),
    })
      .then(function (res) {
        if (res.status === 401) { handlePilotUnauthorized(); return null; }
        return res.json();
      })
      .then(function (data) {
        if (!data) return;
        if (data.error) {
          showError("Failed: " + data.error);
          return;
        }
        if (!adminToken) myNotFoundReports[fountainId] = data.your_report;
        var f = fountainIndex[fountainId];
        if (f) {
          f.not_found_count = data.not_found_count;
          f.not_found = data.not_found;
          f.last_not_found_at = data.last_not_found_at;
        }
        map.closePopup();
        renderAll();
      })
      .catch(function () {
        showError("Failed to submit. Please try again.");
      });
  }

  function submitRating(fountainId, score) {
    if (!API_BASE) return;
    var isUnrating = myRatings[fountainId] === score;
    var method = isUnrating ? "DELETE" : "POST";
    fetch(API_BASE + "/fountains/" + fountainId + "/rating", {
      method: method,
      headers: pilotHeaders(),
      body: JSON.stringify({ device_id: deviceId, score: score }),
    })
      .then(function (res) {
        if (res.status === 401) { handlePilotUnauthorized(); return null; }
        return res.json();
      })
      .then(function (data) {
        if (!data) return;
        if (data.error) {
          showError("Rating failed: " + data.error);
          return;
        }
        myRatings[fountainId] = isUnrating ? null : score;
        var f = fountainIndex[fountainId];
        if (f) {
          f.thumbs_up = data.thumbs_up;
          f.thumbs_down = data.thumbs_down;
          f.rating_count = data.rating_count;
          f.last_rated_at = data.last_rated_at;
        }
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
        if (btn.classList.contains("not-found-btn") || btn.classList.contains("confirm-not-found-btn")) {
          showConfirm("Are you sure this fountain is missing? Reporting it Not Found may result in removal from the map.", function () { submitNotFound(fId); });
          return;
        }
        if (btn.classList.contains("undo-not-found-btn")) {
          submitNotFound(fId);
          return;
        }
        if (btn.classList.contains("reinstate-btn")) {
          submitNotFound(fId, adminPin);
          return;
        }
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
    layerControl.classList.remove("hidden");
    legendAdminRow.classList.remove("hidden");
    updateRatingCounts();
    renderAll();
  }

  function deactivateAdminMode() {
    powerUserMode = false;
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
          adminPin = pin;
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
    var rated = 0, unrated = 0;
    fountainList.forEach(function (f) {
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

  var notFoundBtn = document.querySelector('.layer-suboption[data-option="not-found"]');
  var countNotFoundEl = document.getElementById("count-not-found");

  function updateNotFoundCount() {
    if (!fountainIndexLoaded || !countNotFoundEl) return;
    var count = 0;
    fountainList.forEach(function (f) { if (f.not_found) count++; });
    countNotFoundEl.textContent = count;
  }

  notFoundBtn.addEventListener("click", function () {
    layerOptions.showNotFound = !layerOptions.showNotFound;
    notFoundBtn.classList.toggle("active", layerOptions.showNotFound);
    renderAll();
  });

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

  var PILOT_SESSION_KEY = "pilot_unlocked";
  var PILOT_TOKEN_KEY = "pilot_token";

  function isPilotUnlocked() {
    return sessionStorage.getItem(PILOT_SESSION_KEY) === "1";
  }

  function deactivatePilotMode() {
    pilotMode = false;
    pilotToken = null;
    sessionStorage.removeItem(PILOT_SESSION_KEY);
    sessionStorage.removeItem(PILOT_TOKEN_KEY);
    var banner = document.getElementById("request-access-banner");
    if (banner) banner.classList.remove("hidden");
    renderAll();
  }

  function activatePilotMode() {
    pilotMode = true;
    var banner = document.getElementById("request-access-banner");
    if (banner) banner.classList.add("hidden");
    renderAll();
  }

  var pilotModal = document.getElementById("pilot-modal");
  var pilotInput = document.getElementById("pilot-input");
  var pilotError = document.getElementById("pilot-error");
  var pilotSubmitBtn = document.getElementById("pilot-submit-btn");
  var pilotCancelBtn = document.getElementById("pilot-cancel-btn");

  function openPilotModal() {
    pilotInput.value = "";
    pilotError.classList.add("hidden");
    pilotModal.classList.remove("hidden");
    pilotInput.focus();
  }

  function closePilotModal() {
    pilotModal.classList.add("hidden");
    pilotInput.value = "";
    pilotError.classList.add("hidden");
  }

  function submitPilotPin() {
    var pin = pilotInput.value.trim();
    if (!pin) return;
    pilotSubmitBtn.disabled = true;
    pilotSubmitBtn.textContent = "Checking…";
    fetch(API_BASE + "/pilot/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pin: pin }),
    })
      .then(function (res) { return res.json().then(function (d) { return { ok: res.ok, data: d }; }); })
      .then(function (r) {
        pilotSubmitBtn.disabled = false;
        pilotSubmitBtn.textContent = "Unlock";
        if (r.ok) {
          sessionStorage.setItem(PILOT_SESSION_KEY, "1");
          pilotToken = r.data.token;
          sessionStorage.setItem(PILOT_TOKEN_KEY, pilotToken);
          closePilotModal();
          activatePilotMode();
        } else {
          pilotError.classList.remove("hidden");
          pilotInput.value = "";
          pilotInput.focus();
        }
      })
      .catch(function () {
        pilotSubmitBtn.disabled = false;
        pilotSubmitBtn.textContent = "Unlock";
        pilotError.textContent = "Request failed. Try again.";
        pilotError.classList.remove("hidden");
      });
  }

  pilotSubmitBtn.addEventListener("click", submitPilotPin);
  pilotCancelBtn.addEventListener("click", closePilotModal);
  pilotInput.addEventListener("keydown", function (e) {
    if (e.key === "Enter") submitPilotPin();
    if (e.key === "Escape") closePilotModal();
  });
  pilotModal.addEventListener("click", function (e) {
    if (e.target === pilotModal) closePilotModal();
  });

  var pilotUnlockBtn = document.getElementById("pilot-unlock-btn");
  if (pilotUnlockBtn) {
    pilotUnlockBtn.addEventListener("click", openPilotModal);
  }

  function initPilotMode() {
    if (isPilotUnlocked()) {
      pilotToken = sessionStorage.getItem(PILOT_TOKEN_KEY);
      activatePilotMode();
    } else {
      var banner = document.getElementById("request-access-banner");
      if (banner) banner.classList.remove("hidden");
    }
  }

  // ─── Hamburger menu ───────────────────────────────────────────

  var menuDrawer = document.getElementById("menu-drawer");
  var menuOverlay = document.getElementById("menu-overlay");
  var hamburgerBtn = document.getElementById("hamburger-btn");
  var menuCloseBtn = document.getElementById("menu-close-btn");

  function openMenu() {
    menuDrawer.classList.add("open");
    menuOverlay.classList.add("open");
  }

  function closeMenu() {
    menuDrawer.classList.remove("open");
    menuOverlay.classList.remove("open");
  }

  hamburgerBtn.addEventListener("click", openMenu);
  menuCloseBtn.addEventListener("click", closeMenu);
  menuOverlay.addEventListener("click", closeMenu);

  // ─── Content modal ─────────────────────────────────────────────

  var contentModal = document.getElementById("content-modal");
  var contentModalTitle = document.getElementById("content-modal-title");
  var contentModalBody = document.getElementById("content-modal-body");
  var contentModalClose = document.getElementById("content-modal-close");

  var MODAL_TITLES = {
    about:     "About Fountains For All",
    terms:     "Terms of Use",
    privacy:   "Privacy Policy",
    copyright: "Copyright",
  };

  var contentCache = {};

  function openContentModal(key) {
    var title = MODAL_TITLES[key];
    if (!title) return;
    contentModalTitle.textContent = title;
    contentModalBody.scrollTop = 0;
    history.replaceState(null, "", "#" + key);
    if (contentCache[key]) {
      contentModalBody.innerHTML = contentCache[key];
      contentModal.classList.remove("hidden");
      return;
    }
    contentModalBody.innerHTML = '<p style="color:#aaa;font-size:14px">Loading…</p>';
    contentModal.classList.remove("hidden");
    fetch("page_content/" + key + ".html")
      .then(function (res) { return res.text(); })
      .then(function (html) {
        contentCache[key] = html;
        contentModalBody.innerHTML = html;
      })
      .catch(function () {
        contentModalBody.innerHTML = '<p style="color:#c62828">Failed to load content.</p>';
      });
  }

  function closeContentModal() {
    contentModal.classList.add("hidden");
    history.replaceState(null, "", location.pathname);
  }

  contentModalClose.addEventListener("click", closeContentModal);
  contentModal.addEventListener("click", function (e) {
    if (e.target === contentModal) closeContentModal();
  });

  document.querySelectorAll(".menu-item[data-modal]").forEach(function (btn) {
    btn.addEventListener("click", function () {
      closeMenu();
      openContentModal(btn.dataset.modal);
    });
  });

  var initialHash = location.hash.replace("#", "");
  if (MODAL_TITLES[initialHash]) {
    openContentModal(initialHash);
  }

  var menuAdminBtn = document.getElementById("menu-admin-btn");
  menuAdminBtn.addEventListener("click", function () {
    closeMenu();
    if (powerUserMode) {
      deactivateAdminMode();
    } else if (isAdminUnlocked()) {
      activateAdminMode();
    } else {
      openPinModal();
    }
  });

  initPilotMode();
  fetchFountains();
  preloadLocation();
})();
