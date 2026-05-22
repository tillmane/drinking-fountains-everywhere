(function () {
  "use strict";

  var API_BASE = "https://drinking-fountains-api.tillmane.workers.dev";

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

  function makeIcon(color) {
    return L.divIcon({
      className: "fountain-marker",
      html: '<svg width="28" height="36" viewBox="0 0 28 36" xmlns="http://www.w3.org/2000/svg">' +
        '<path d="M14 0C6.27 0 0 6.27 0 14c0 10.5 14 22 14 22s14-11.5 14-22C28 6.27 21.73 0 14 0z" fill="' + color + '" stroke="#fff" stroke-width="1.5"/>' +
        '<path d="M14 7c0 0-5 5.5-5 9a5 5 0 0 0 10 0c0-3.5-5-9-5-9z" fill="#fff" opacity="0.9"/>' +
      '</svg>',
      iconSize: [28, 36],
      iconAnchor: [14, 36],
      popupAnchor: [0, -30],
    });
  }

  var icons = {
    cityOn:      makeIcon("#2563eb"),
    cityOff:     makeIcon("#c62828"),
    osm:         makeIcon("#0891b2"),
    reportedOff: makeIcon("#e67e22"),
  };

  function lookupFountain(sourceType, sourceId) {
    return fountainIndex[sourceType + ":" + sourceId] || null;
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

  function buildStarsDisplay(avg) {
    if (avg == null) return '<span class="stars-empty">No ratings</span>';
    var html = "";
    var rounded = Math.round(avg);
    for (var i = 1; i <= 5; i++) {
      html += '<span class="star-display ' + (i <= rounded ? "star-filled" : "star-empty") + '">★</span>';
    }
    return html;
  }

  function buildRateStars(fountainId) {
    var html = "";
    for (var i = 1; i <= 5; i++) {
      html += '<span class="rate-star" data-fountain-id="' + fountainId + '" data-score="' + i + '">★</span>';
    }
    return html;
  }

  function buildPowerUserSection(local) {
    if (!powerUserMode || !local) return "";
    var bottleChecked = local.user_bottle_filler ? " checked" : "";
    var dogChecked = local.user_dog_bowl ? " checked" : "";
    return '<div class="power-user-section">' +
      '<div class="power-user-section-header">Edit Attributes</div>' +
      '<div class="attr-checkbox-row">' +
        '<input type="checkbox" id="attr-bottle-' + local.id + '" class="attr-checkbox" data-fountain-id="' + local.id + '" data-attribute="bottle_filler"' + bottleChecked + '>' +
        '<label for="attr-bottle-' + local.id + '">Bottle Filler</label>' +
      '</div>' +
      '<div class="attr-checkbox-row">' +
        '<input type="checkbox" id="attr-dog-' + local.id + '" class="attr-checkbox" data-fountain-id="' + local.id + '" data-attribute="dog_bowl"' + dogChecked + '>' +
        '<label for="attr-dog-' + local.id + '">Dog Bowl</label>' +
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
        buildPowerUserSection(local) +
      '</div>';
    }

    var avgDisplay = local.avg_rating ? local.avg_rating.toFixed(1) : "";
    var starsHtml = buildStarsDisplay(local.avg_rating);
    var countText = local.rating_count ? "(" + local.rating_count + ")" : "";
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
      '<div class="rating-summary">' +
        starsHtml +
        ' <span class="rating-avg">' + avgDisplay + '</span>' +
        ' <span class="rating-count">' + countText + '</span>' +
      '</div>' +
      (lastRated ? '<div class="rating-last">' + lastRated + '</div>' : '') +
      '<div class="rating-yours">' +
        '<span class="rating-yours-label">Rate:</span>' +
        buildRateStars(local.id) +
      '</div>' +
      '<div class="report-actions">' + reportBtnHtml + '</div>' +
      buildPowerUserSection(local) +
    '</div>';
  }

  function buildCityPopup(f) {
    var running = isCityRunning(f);
    var local = lookupFountain("city_gis", String(f.OBJECTID));
    var details = "";
    if (isYes(f.ACCESSIBLE_MODEL))
      details += '<div><span class="detail-label">Accessible:</span> Yes</div>';
    if (isYes(f.BOTTLE_FILLER) || (local && local.user_bottle_filler))
      details += '<div><span class="detail-label">Bottle Filler:</span> Yes</div>';
    if (isYes(f.DOG_BOWL) || (local && local.user_dog_bowl))
      details += '<div><span class="detail-label">Dog Bowl:</span> Yes</div>';
    if (!running)
      details += '<div><span class="detail-label">Reason Off:</span> ' + (f.REASON_OFF || "UNKNOWN") + '</div>';
    details += '<div class="popup-source">Seattle City GIS</div>';

    return '<div class="fountain-popup">' +
      '<h3>' + (f.PARK || "Drinking Fountain") + '</h3>' +
      (running ? "" : '<span class="status off">Shut Off</span>') +
      '<div class="details">' + details + '</div>' +
      buildRatingSection("city_gis", String(f.OBJECTID), !running) +
    '</div>';
  }

  function buildOsmPopup(el) {
    var tags = el.tags || {};
    var local = lookupFountain("osm", String(el.id));
    var details = "";
    if (tags.wheelchair === "yes")
      details += '<div><span class="detail-label">Accessible:</span> Yes</div>';
    if (tags.bottle === "yes" || (local && local.user_bottle_filler))
      details += '<div><span class="detail-label">Bottle Filler:</span> Yes</div>';
    if (tags.dog === "yes" || (local && local.user_dog_bowl))
      details += '<div><span class="detail-label">Dog Bowl:</span> Yes</div>';
    if (tags.check_date)
      details += '<div><span class="detail-label">Last Verified:</span> ' + tags.check_date + '</div>';
    details += '<div class="popup-source">OpenStreetMap</div>';

    return '<div class="fountain-popup">' +
      '<h3>' + (tags.name || "Drinking Fountain") + '</h3>' +
      '<div class="details">' + details + '</div>' +
      buildRatingSection("osm", String(el.id), false) +
    '</div>';
  }

  function getCityIcon(f) {
    if (!isCityRunning(f)) return icons.cityOff;
    if (isReportedOff("city_gis", String(f.OBJECTID))) return icons.reportedOff;
    return icons.cityOn;
  }

  function getOsmIcon(el) {
    if (isReportedOff("osm", String(el.id))) return icons.reportedOff;
    return icons.osm;
  }

  function renderCity() {
    sources.city.layerGroup.clearLayers();
    sources.city.data.forEach(function (f) {
      if (f.LIFE_CYCLE_CODE !== "A") return;
      if (activeFilters.accessible && !isYes(f.ACCESSIBLE_MODEL)) return;
      if (activeFilters.bottle && !fountainHasBottle("city_gis", String(f.OBJECTID), f)) return;
      if (activeFilters.dog && !fountainHasDog("city_gis", String(f.OBJECTID), f)) return;
      if (layerOptions.cityUniqueOnly && cityHasOsmMatch(f)) return;

      L.marker([f.LATITUDE, f.LONGITUDE], { icon: getCityIcon(f) })
        .bindPopup(function () { return buildCityPopup(f); })
        .addTo(sources.city.layerGroup);
    });
  }

  function renderOsm() {
    sources.osm.layerGroup.clearLayers();
    sources.osm.data.forEach(function (el) {
      if (activeFilters.accessible && el.tags.wheelchair !== "yes") return;
      if (activeFilters.bottle && !fountainHasBottle("osm", String(el.id), el)) return;
      if (activeFilters.dog && !fountainHasDog("osm", String(el.id), el)) return;

      L.marker([el.lat, el.lon], { icon: getOsmIcon(el) })
        .bindPopup(function () { return buildOsmPopup(el); })
        .addTo(sources.osm.layerGroup);
    });
  }

  function renderAll() {
    renderCity();
    renderOsm();
    updateCount();
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
    fetch(API_BASE + "/fountains/" + fountainId + "/rating", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ device_id: deviceId, score: score }),
    })
      .then(function (res) { return res.json(); })
      .then(function (data) {
        if (data.error) {
          showError("Rating failed: " + data.error);
          return;
        }
        Object.keys(fountainIndex).forEach(function (key) {
          if (fountainIndex[key].id === fountainId) {
            fountainIndex[key].avg_rating = data.avg_rating;
            fountainIndex[key].rating_count = data.rating_count;
            fountainIndex[key].last_rated_at = data.last_rated_at;
          }
        });
        updateOpenPopupRating(fountainId, data);
      })
      .catch(function () {
        showError("Failed to submit rating. Please try again.");
      });
  }

  function updateOpenPopupRating(fountainId, data) {
    var section = document.querySelector('.rating-section[data-fountain-id="' + fountainId + '"]');
    if (!section) return;

    var summary = section.querySelector(".rating-summary");
    if (summary) {
      var rounded = Math.round(data.avg_rating);
      var starsHtml = "";
      for (var i = 1; i <= 5; i++) {
        starsHtml += '<span class="star-display ' + (i <= rounded ? "star-filled" : "star-empty") + '">★</span>';
      }
      summary.innerHTML = starsHtml +
        ' <span class="rating-avg">' + data.avg_rating.toFixed(1) + '</span>' +
        ' <span class="rating-count">(' + data.rating_count + ')</span>';
    }

    var lastEl = section.querySelector(".rating-last");
    if (lastEl) {
      lastEl.textContent = "Last rated " + formatRelativeDate(data.last_rated_at);
    } else {
      var newLast = document.createElement("div");
      newLast.className = "rating-last";
      newLast.textContent = "Last rated " + formatRelativeDate(data.last_rated_at);
      summary.insertAdjacentElement("afterend", newLast);
    }

    if (data.your_score) {
      var rateStars = section.querySelectorAll(".rate-star");
      rateStars.forEach(function (star) {
        var s = parseInt(star.dataset.score);
        star.classList.toggle("active", s <= data.your_score);
      });
    }
  }

  map.on("popupopen", function (e) {
    var container = e.popup.getElement();
    if (!container) return;
    var stars = container.querySelectorAll(".rate-star");
    stars.forEach(function (star, idx) {
      star.addEventListener("click", function () {
        var fId = parseInt(this.dataset.fountainId);
        var score = parseInt(this.dataset.score);
        submitRating(fId, score);
      });
      star.addEventListener("mouseenter", function () {
        stars.forEach(function (s, i) {
          s.classList.toggle("hover", i <= idx);
        });
      });
      star.addEventListener("mouseleave", function () {
        stars.forEach(function (s) {
          s.classList.remove("hover");
        });
      });
    });
    container.querySelectorAll(".report-btn").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var fId = parseInt(this.dataset.fountainId);
        var status = this.dataset.status;
        submitReport(fId, status);
      });
    });
    container.querySelectorAll(".attr-checkbox").forEach(function (cb) {
      cb.addEventListener("change", function () {
        var fId = parseInt(this.dataset.fountainId);
        var attr = this.dataset.attribute;
        submitAttribute(fId, attr, this.checked);
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

  function locateUser() {
    if (locating) return;
    if (!navigator.geolocation) {
      showError("Geolocation is not supported by your browser.");
      return;
    }
    locating = true;
    locateBtn.classList.add("locating");

    var watchId = navigator.geolocation.watchPosition(
      function (pos) {
        navigator.geolocation.clearWatch(watchId);
        locating = false;
        locateBtn.classList.remove("locating");
        panToLocation(pos.coords.latitude, pos.coords.longitude);
      },
      function (err) {
        navigator.geolocation.clearWatch(watchId);
        locating = false;
        locateBtn.classList.remove("locating");
        if (err.code === 1) {
          showError("Location access denied. Check your browser permissions.");
        } else {
          showError("Unable to get your location. Try again.");
        }
      },
      { enableHighAccuracy: true, timeout: 20000, maximumAge: 30000 }
    );
  }

  locateBtn.addEventListener("click", locateUser);

  document.querySelectorAll(".filter-toggle").forEach(function (btn) {
    btn.addEventListener("click", function () {
      var filter = btn.dataset.filter;
      activeFilters[filter] = !activeFilters[filter];
      btn.classList.toggle("active");
      renderAll();
    });
  });

  var powerUserBtn = document.getElementById("power-user-btn");
  var layerControl = document.getElementById("layer-control");

  powerUserBtn.addEventListener("click", function () {
    powerUserMode = !powerUserMode;
    powerUserBtn.classList.toggle("active");
    layerControl.classList.toggle("hidden", !powerUserMode);
  });

  var cityUniqueBtn = document.querySelector('.layer-suboption[data-option="city-unique"]');

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

  fetchCity();
  fetchOsm();
  fetchFountainIndex();
})();
