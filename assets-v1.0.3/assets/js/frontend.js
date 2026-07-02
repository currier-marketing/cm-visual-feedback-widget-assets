(function () {
  "use strict";

  var config = window.CMVisualFeedbackWidgetData || window.WPLoopData;

  if (!config) {
    return;
  }
  var root = document.getElementById("wp-loop-root");

  if (!root || !config.permissions || !config.permissions.canComment) {
    return;
  }

  var devicePresets = [
    { name: "Wide Desktop", width: 1920, icon: "desktop" },
    { name: "Large Desktop", width: 1440, icon: "desktop" },
    { name: "Tablet", width: 768, icon: "tablet" },
    { name: "Mobile", width: 320, icon: "smartphone" },
  ];

  var state = {
    mode: "navigate",
    threads: [],
    panelOpen: false,
    panelView: "list",
    activeThreadId: 0,
    showResolved: false,
    deviceMode: null,
    hoveredElement: null,
    selectedAnchor: null,
    guestName:
      config.currentUser && config.currentUser.displayName
        ? config.currentUser.displayName
        : "",
    guestEmail: "",
    replyParentId: 0,
    attachmentFile: null,
    pendingAttachment: null,
    uploadingAttachment: false,
    screenshotUri: null,
    capturingScreenshot: false,
    busy: false,
    notice: null,
    popoverOpen: false,
  };

  var refs = {};
  var noticeTimer = null;
  var themeMediaQuery = window.matchMedia
    ? window.matchMedia("(prefers-color-scheme: dark)")
    : null;

  init();

  function init() {
    root.innerHTML = [
      '<div class="wp-loop-app">',
      '<div class="wp-loop-toolbar"></div>',
      '<div class="wp-loop-notice wp-loop-hidden"></div>',
      '<div class="wp-loop-highlight" hidden></div>',
      '<div class="wp-loop-markers"></div>',
      '<div class="wp-loop-popover" hidden></div>',
      '<aside class="wp-loop-panel"></aside>',
      "</div>",
    ].join("");

    refs.toolbar = root.querySelector(".wp-loop-toolbar");
    refs.notice = root.querySelector(".wp-loop-notice");
    refs.highlight = root.querySelector(".wp-loop-highlight");
    refs.markers = root.querySelector(".wp-loop-markers");
    refs.popover = root.querySelector(".wp-loop-popover");
    refs.panel = root.querySelector(".wp-loop-panel");
    refs.richTextEditors = {};

    applyTheme();
    renderToolbar();
    renderPanel();
    bindUiEvents();
    bindGlobalEvents();
    loadThreads();
  }

  function bindUiEvents() {
    root.addEventListener("click", function (event) {
      var target = event.target.closest("[data-action]");
      if (!target) {
        return;
      }

      var action = target.getAttribute("data-action");

      if ("set-mode" === action) {
        setMode(target.getAttribute("data-mode"));
        return;
      }

      if ("toggle-panel" === action) {
        state.panelOpen = !state.panelOpen;
        if (!state.panelOpen) {
          state.panelView = "list";
          state.activeThreadId = 0;
        }
        renderPanel();
        return;
      }

      if ("toggle-resolved" === action) {
        state.showResolved = !state.showResolved;
        renderToolbar();
        renderPanel();
        renderMarkers();
        return;
      }

      if ("open-thread" === action) {
        state.activeThreadId =
          parseInt(target.getAttribute("data-thread-id"), 10) || 0;
        state.panelView = "thread";
        state.panelOpen = true;
        state.replyParentId = 0;
        renderPanel();
        return;
      }

      if ("back-to-list" === action) {
        state.panelView = "list";
        state.activeThreadId = 0;
        state.replyParentId = 0;
        renderPanel();
        return;
      }

      if ("cancel-compose" === action) {
        cancelCompose();
        return;
      }

      if ("reply-to-reply" === action) {
        state.replyParentId =
          parseInt(target.getAttribute("data-reply-id"), 10) || 0;
        state.panelView = "thread";
        state.panelOpen = true;
        renderPanel();
        return;
      }

      if ("clear-reply-target" === action) {
        state.replyParentId = 0;
        renderPanel();
        return;
      }

      if ("resolve-thread" === action) {
        event.preventDefault();
        resolveThread(parseInt(target.getAttribute("data-thread-id"), 10) || 0);
        return;
      }

      if ("remove-file" === action) {
        event.preventDefault();
        state.attachmentFile = null;
        state.pendingAttachment = null;
        state.uploadingAttachment = false;
        updateAttachmentField(target.closest(".wp-loop-attachment-field"));
        return;
      }



      if ("apply-custom-device" === action) {
        event.preventDefault();
        var input = refs.toolbar.querySelector(
          "[data-custom-device-width]",
        );
        if (!input) {
          return;
        }
        var customWidth = parseInt(input.value, 10);
        if (isNaN(customWidth) || customWidth < 240 || customWidth > 9999) {
          return;
        }
        setDeviceMode("Custom", customWidth);
        return;
      }

      if ("toggle-device-dropdown" === action) {
        event.preventDefault();
        event.stopPropagation();
        toggleDeviceDropdown(event);
        return;
      }

      if ("set-device" === action) {
        event.preventDefault();
        var deviceName = target.getAttribute("data-device") || "";
        setDeviceMode(deviceName);
        return;
      }
    });

    root.addEventListener("submit", function (event) {
      var form = event.target;
      var editorPayload = getEditorPayload(form);
      event.preventDefault();

      if (form.matches('[data-form="thread"]')) {
        createThread(new FormData(form), editorPayload);
        return;
      }

      if (form.matches('[data-form="reply"]')) {
        createReply(new FormData(form), editorPayload);
      }
    });

    root.addEventListener("change", function (event) {
      var target = event.target;

      if (!target.matches(".wp-loop-file-input")) {
        return;
      }

      var file = target.files && target.files[0];

      if (!file) {
        return;
      }

      var maxSize =
        config.upload && config.upload.maxSize
          ? config.upload.maxSize
          : 2097152;

      if (file.size > maxSize) {
        showNotice(config.strings.uploadTooLarge, true);
        target.value = "";
        return;
      }

      var allowedTypes =
        config.upload && config.upload.allowedTypes
          ? config.upload.allowedTypes
          : {};
      var ext = file.name.split(".").pop().toLowerCase();

      if (
        Object.keys(allowedTypes).length > 0 &&
        !allowedTypes.hasOwnProperty(ext)
      ) {
        showNotice(config.strings.uploadTypeNotAllowed, true);
        target.value = "";
        return;
      }

      state.attachmentFile = file;
      state.pendingAttachment = null;
      state.uploadingAttachment = false;
      updateAttachmentField(target.closest(".wp-loop-attachment-field"));
    });

    root.addEventListener("input", function (event) {
      var target = event.target;
      if (!target.name) {
        return;
      }

      if ("author_name" === target.name) {
        state.guestName = target.value;
      }

      if ("author_email" === target.name) {
        state.guestEmail = target.value;
      }
    });
  }

  function bindGlobalEvents() {
    document.addEventListener("mousemove", handleCommentHover, true);
    document.addEventListener("click", handleCommentClick, true);
    window.addEventListener("scroll", handleViewportChange, { passive: true });
    window.addEventListener("resize", handleViewportChange);

    document.addEventListener("click", function (event) {
      closeDeviceDropdown();
      if (state.popoverOpen && !refs.popover.contains(event.target) && !refs.toolbar.contains(event.target)) {
        cancelCompose();
      }
    });

    if (themeMediaQuery) {
      if (themeMediaQuery.addEventListener) {
        themeMediaQuery.addEventListener("change", applyTheme);
      } else if (themeMediaQuery.addListener) {
        themeMediaQuery.addListener(applyTheme);
      }
    }
  }

  function handleViewportChange() {
    renderMarkers();
    updateHighlight();
  }

  function setMode(mode) {
    state.mode = "comment" === mode ? "comment" : "navigate";
    if ("comment" === state.mode) {
      showNotice(config.strings.clickElementPrompt);
      document.body.classList.add("wp-loop-comment-mode");
    } else {
      hideNotice();
      state.hoveredElement = null;
      state.selectedAnchor = null;
      document.body.classList.remove("wp-loop-comment-mode");
      hideHighlight();
      if (state.popoverOpen) {
        closePopover();
      }
    }
    renderToolbar();
  }

  function applyTheme() {
    var theme = config.defaultTheme || "system";
    if ("system" === theme) {
      theme = themeMediaQuery && themeMediaQuery.matches ? "dark" : "light";
    }
    root.setAttribute("data-theme", theme);
  }

  function renderToolbar() {
    var visibleCount = getVisibleThreads().length;
    refs.toolbar.innerHTML = [
      '<div class="wp-loop-toolbar__group">',
      buttonMarkup(
        config.strings.navigateMode,
        "set-mode",
        state.mode === "navigate",
        { mode: "navigate" },
        "admin-site-alt3",
        { iconOnly: true },
      ),
      buttonMarkup(
        config.strings.commentMode,
        "set-mode",
        state.mode === "comment",
        { mode: "comment" },
        "format-chat",
        { iconOnly: true },
      ),
      "</div>",
      '<div class="wp-loop-toolbar__group">',
      actionButtonMarkup(
        "wp-loop-ghost-button",
        "toggle-panel",
        config.strings.threads,
        "admin-comments",
        {},
        {
          iconOnly: true,
          count: visibleCount,
          extraClass: "wp-loop-button--with-badge",
          expanded: state.panelOpen,
        },
      ),
      actionButtonMarkup(
        "wp-loop-ghost-button",
        "toggle-resolved",
        config.strings.showResolved,
        state.showResolved ? "visibility" : "hidden",
        {},
        {
          iconOnly: true,
          active: state.showResolved,
          pressed: state.showResolved,
        },
      ),
      "</div>",
      '<div class="wp-loop-toolbar__group">',
      renderDeviceToggle(),
      "</div>",
    ].join("");

    bindDeviceInputEvents();
  }

  function renderDeviceToggle() {
    var current = state.deviceMode;
    var label = current ? current.preset.name : "Responsive";
    var icon = current ? current.preset.icon : "desktop";

    return [
      '<div class="wp-loop-device-wrapper">',
      actionButtonMarkup(
        "wp-loop-ghost-button",
        "toggle-device-dropdown",
        label,
        icon,
        {},
        { iconOnly: true },
      ),
      '<div class="wp-loop-device-dropdown wp-loop-hidden" data-device-dropdown>',
      devicePresets
        .map(function (preset) {
          var isActive =
            current && current.preset.name === preset.name;
          return [
            '<button type="button" class="wp-loop-device-option',
            isActive ? " is-active" : "",
            '" data-action="set-device" data-device="',
            preset.name,
            '" data-width="',
            String(preset.width),
            '">',
            '<span class="dashicons dashicons-',
            preset.icon,
            '"></span>',
            '<span class="wp-loop-device-option__label">',
            preset.name,
            "</span>",
            '<span class="wp-loop-device-option__width">',
            String(preset.width),
            "px</span>",
            "</button>",
          ].join("");
        })
        .join(""),
      '<div class="wp-loop-device-separator"></div>',
      '<div class="wp-loop-device-custom">',
      '<div class="wp-loop-device-custom__row">',
      '<input type="number" class="wp-loop-device-custom__input" data-custom-device-width placeholder="Custom" min="240" max="9999" value="',
      current && current.preset.isCustom ? String(current.preset.width) : "",
      '" />',
      '<span class="wp-loop-device-custom__suffix">px</span>',
      '<button type="button" class="wp-loop-device-custom__apply" data-action="apply-custom-device">',
      "Apply",
      "</button>",
      "</div>",
      '<div class="wp-loop-device-custom__hint">Enter width 240-9999px</div>',
      "</div>",
      '<div class="wp-loop-device-separator"></div>',
      '<button type="button" class="wp-loop-device-option',
      !current ? " is-active" : "",
      '" data-action="set-device" data-device="">',
      '<span class="dashicons dashicons-editor-expand"></span>',
      '<span class="wp-loop-device-option__label">Full width</span>',
      "</button>",
      "</div>",
      "</div>",
    ].join("");
  }

  function setDeviceMode(deviceName, customWidth) {
    closeDeviceDropdown();

    if (!deviceName) {
      if (state.deviceMode) {
        unwrapBodyContent();
        state.deviceMode = null;
        document.documentElement.classList.remove(
          "wp-loop-device-active",
        );
      }
      renderToolbar();
      renderPanel();
      renderMarkers();
      return;
    }

    var isCustom = deviceName === "Custom";
    var preset = isCustom
      ? {
          name: customWidth + "px",
          width: customWidth,
          icon: "smartphone",
          isCustom: true,
        }
      : null;

    if (!isCustom) {
      for (var i = 0; i < devicePresets.length; i += 1) {
        if (devicePresets[i].name === deviceName) {
          preset = devicePresets[i];
          break;
        }
      }
    }

    if (!preset) {
      return;
    }

    if (
      state.deviceMode &&
      state.deviceMode.preset.name === preset.name
    ) {
      unwrapBodyContent();
      state.deviceMode = null;
      document.documentElement.classList.remove(
        "wp-loop-device-active",
      );
      renderToolbar();
      renderPanel();
      renderMarkers();
      return;
    }

    if (state.deviceMode) {
      unwrapBodyContent();
    }

    state.deviceMode = { preset: preset };
    wrapBodyContent(preset.width);
    document.documentElement.classList.add("wp-loop-device-active");
    renderToolbar();
    renderPanel();
    renderMarkers();
  }

  function wrapBodyContent(width) {
    var html = document.documentElement;
    html.style.setProperty("--wp-loop-device-width", String(width) + "px");
    document.body.style.maxWidth = String(width) + "px";
    document.body.style.marginLeft = "auto";
    document.body.style.marginRight = "auto";
  }

  function unwrapBodyContent() {
    document.body.style.maxWidth = "";
    document.body.style.marginLeft = "";
    document.body.style.marginRight = "";
    document.documentElement.style.removeProperty(
      "--wp-loop-device-width",
    );
  }

  function getDeviceContextKey() {
    if (!state.deviceMode) {
      return "";
    }
    var key = state.deviceMode.preset.name
      .toLowerCase()
      .replace(/\s+/g, "-");
    if (state.deviceMode.preset.isCustom) {
      key = "custom";
    }
    return key + ":" + String(state.deviceMode.preset.width);
  }

  function getDeviceLabelFromContext(context) {
    if (!context) {
      return "";
    }
    var parts = context.split(":");
    if (!parts[0]) {
      return "";
    }
    var label = parts[0].replace(/-/g, " ");
    label = label.replace(/\b\w/g, function (c) {
      return c.toUpperCase();
    });
    var width = parts[1];
    if (width) {
      label += " " + width;
    }
    return label;
  }

  function renderDeviceBadge(thread) {
    if (!thread.deviceContext) {
      return "";
    }
    var label = getDeviceLabelFromContext(thread.deviceContext);
    var parts = thread.deviceContext.split(":");
    var icon = "smartphone";
    if (parts[0] === "wide-desktop" || parts[0] === "large-desktop") {
      icon = "desktop";
    } else if (parts[0] === "tablet") {
      icon = "tablet";
    }
    return [
      '<span class="wp-loop-device-badge">',
      iconMarkup(icon, "wp-loop-meta-icon"),
      escapeHtml(label),
      "</span>",
    ].join("");
  }

  function closeDeviceDropdown() {
    var dropdown = refs.toolbar.querySelector(
      "[data-device-dropdown]",
    );
    if (dropdown) {
      dropdown.classList.add("wp-loop-hidden");
    }
  }

  function toggleDeviceDropdown(event) {
    event.stopPropagation();
    var dropdown = refs.toolbar.querySelector(
      "[data-device-dropdown]",
    );
    if (!dropdown) {
      return;
    }
    dropdown.classList.toggle("wp-loop-hidden");
  }

  function bindDeviceInputEvents() {
    var input = refs.toolbar.querySelector(
      "[data-custom-device-width]",
    );
    if (!input) {
      return;
    }
    input.addEventListener("click", function (event) {
      event.stopPropagation();
    });
  }

  function renderPanel() {
    refs.panel.classList.toggle("is-open", !!state.panelOpen);

    if (!state.panelOpen) {
      refs.panel.innerHTML = "";
      if (!state.popoverOpen) {
        refs.richTextEditors = {};
      }
      return;
    }

    if ("thread" === state.panelView && getActiveThread()) {
      renderThreadPanel();
      return;
    }

    renderListPanel();
  }

  function renderListPanel() {
    var threads = getVisibleThreads();
    var body = threads.length
      ? '<div class="wp-loop-thread-list">' +
        threads.map(renderThreadCard).join("") +
        "</div>"
      : '<div class="wp-loop-empty">' +
        escapeHtml(config.strings.noThreads) +
        "</div>";

    refs.panel.innerHTML = [
      '<div class="wp-loop-panel__header">',
      '<div class="wp-loop-panel__header-row">',
      "<div>",
      '<h2 class="wp-loop-panel__title">',
      escapeHtml(config.strings.threads),
      "</h2>",
      '<div class="wp-loop-panel__subtitle">',
      escapeHtml(config.pageUrl || ""),
      "</div>",
      "</div>",
      iconButtonMarkup("toggle-panel", config.strings.close, "dismiss"),
      "</div>",
      "</div>",
      '<div class="wp-loop-panel__body">',
      body,
      "</div>",
    ].join("");
  }

  function renderThreadPanel() {
    var thread = getActiveThread();
    var replyTarget = state.replyParentId
      ? findReplyById(thread.replies, state.replyParentId)
      : null;
    var replyTargetMarkup = replyTarget
      ? [
          '<div class="wp-loop-help">',
          escapeHtml(config.strings.replyingTo),
          ": ",
          escapeHtml(replyTarget.author.name || config.strings.guest),
          " ",
          actionButtonMarkup(
            "wp-loop-inline-button",
            "clear-reply-target",
            config.strings.cancel,
            "dismiss",
            {},
            { iconOnly: true },
          ),
          "</div>",
        ].join("")
      : "";

    refs.panel.innerHTML = [
      '<div class="wp-loop-panel__header">',
      '<div class="wp-loop-panel__header-row">',
      "<div>",
      '<h2 class="wp-loop-panel__title">',
      escapeHtml(config.strings.threads),
      "</h2>",
      '<div class="wp-loop-panel__subtitle">',
      escapeHtml(thread.selector),
      "</div>",
      "</div>",
      '<div class="wp-loop-panel__actions">',
      actionButtonMarkup(
        "wp-loop-inline-button",
        "back-to-list",
        config.strings.backToThreads,
        "arrow-left-alt2",
        {},
        { iconOnly: true },
      ),
      iconButtonMarkup("toggle-panel", config.strings.close, "dismiss"),
      "</div>",
      "</div>",
      "</div>",
      '<div class="wp-loop-panel__body">',
      renderThreadDetail(thread),
      replyTargetMarkup,
      renderReplyForm(thread),
      "</div>",
    ].join("");

    initializeRichTextEditors();
  }

  function renderThreadCard(thread, index) {
    var excerpt = getCommentExcerpt(thread.content, thread.contentIsHtml);
    var replyCount = countReplies(thread.replies);
    var markerIndex =
      typeof index === "number"
        ? index + 1
        : getVisibleThreads().indexOf(thread) + 1;

    return [
      '<button type="button" class="wp-loop-thread-card" data-action="open-thread" data-thread-id="',
      String(thread.id),
      '">',
      '<div class="wp-loop-thread-meta">',
      '<span class="wp-loop-status wp-loop-status--',
      escapeHtml(thread.status),
      '">',
      escapeHtml(
        "resolved" === thread.status
          ? config.strings.resolved
          : config.strings.open,
      ),
      "</span>",
      renderDeviceBadge(thread),
      '<span class="wp-loop-meta-item">',
      iconMarkup("location", "wp-loop-meta-icon"),
      "#",
      String(markerIndex),
      "</span>",
      '<span class="wp-loop-meta-item">',
      iconMarkup("admin-users", "wp-loop-meta-icon"),
      escapeHtml(thread.author.name || config.strings.guest),
      "</span>",
      '<span class="wp-loop-meta-item">',
      iconMarkup("calendar-alt", "wp-loop-meta-icon"),
      escapeHtml(formatDate(thread.createdAt)),
      "</span>",
      '<span class="wp-loop-meta-item">',
      iconMarkup("admin-comments", "wp-loop-meta-icon"),
      String(replyCount),
      " ",
      escapeHtml(config.strings.replies),
      "</span>",
      thread.attachmentUrl
        ? '<span class="wp-loop-meta-item">' +
          iconMarkup("paperclip", "wp-loop-meta-icon") +
          "</span>"
        : "",
      "</div>",
      '<p class="wp-loop-thread-content">',
      escapeHtml(excerpt),
      "</p>",
      '<div class="wp-loop-thread-anchor">',
      escapeHtml(thread.selector),
      "</div>",
      "</button>",
    ].join("");
  }

  function renderThreadDetail(thread) {
    return [
      '<div class="wp-loop-thread-detail">',
      '<div class="wp-loop-thread-meta">',
      '<span class="wp-loop-status wp-loop-status--',
      escapeHtml(thread.status),
      '">',
      escapeHtml(
        "resolved" === thread.status
          ? config.strings.resolved
          : config.strings.open,
      ),
      "</span>",
      renderDeviceBadge(thread),
      '<span class="wp-loop-meta-item">',
      iconMarkup("admin-users", "wp-loop-meta-icon"),
      escapeHtml(thread.author.name || config.strings.guest),
      "</span>",
      '<span class="wp-loop-meta-item">',
      iconMarkup("calendar-alt", "wp-loop-meta-icon"),
      escapeHtml(formatDate(thread.createdAt)),
      "</span>",
      "</div>",
      renderCommentContentMarkup(
        thread.content,
        thread.contentIsHtml,
        "wp-loop-thread-content",
      ),
      renderAttachmentMarkup(thread.attachmentUrl, thread.attachmentId),
      renderScreenshotMarkup(thread.screenshotUri),
      '<div class="wp-loop-thread-anchor">',
      escapeHtml(thread.selector),
      "</div>",
      '<div class="wp-loop-thread-actions">',
      thread.canResolve && "resolved" !== thread.status
        ? actionButtonMarkup(
            "wp-loop-resolve-button",
            "resolve-thread",
            config.strings.resolve,
            "yes-alt",
            { threadId: thread.id },
            { iconOnly: true },
          )
        : "",
      "</div>",
      "</div>",
      '<div class="wp-loop-replies">',
      thread.replies.length ? renderReplies(thread.replies) : "",
      "</div>",
    ].join("");
  }

  function renderReplies(replies) {
    return replies
      .map(function (reply) {
        return [
          '<div class="wp-loop-reply-card">',
          '<div class="wp-loop-reply-meta">',
          '<span class="wp-loop-meta-item">',
          iconMarkup("admin-users", "wp-loop-meta-icon"),
          escapeHtml(reply.author.name || config.strings.guest),
          "</span>",
          '<span class="wp-loop-meta-item">',
          iconMarkup("calendar-alt", "wp-loop-meta-icon"),
          escapeHtml(formatDate(reply.createdAt)),
          "</span>",
          "</div>",
          renderCommentContentMarkup(
            reply.content,
            reply.contentIsHtml,
            "wp-loop-reply-content",
          ),
          renderAttachmentMarkup(reply.attachmentUrl, reply.attachmentId),
          renderScreenshotMarkup(reply.screenshotUri),
          '<div class="wp-loop-reply-actions">',
          actionButtonMarkup(
            "wp-loop-inline-button",
            "reply-to-reply",
            config.strings.replyToThis,
            "undo",
            { replyId: reply.id },
            { iconOnly: true },
          ),
          "</div>",
          reply.children && reply.children.length
            ? '<div class="wp-loop-reply-children">' +
              renderReplies(reply.children) +
              "</div>"
            : "",
          "</div>",
        ].join("");
      })
      .join("");
  }

  function renderReplyForm(thread) {
    if ("resolved" === thread.status) {
      return (
        '<div class="wp-loop-help">' +
        escapeHtml(config.strings.resolvedSaved) +
        "</div>"
      );
    }

    return [
      '<form class="wp-loop-form" data-form="reply">',
      renderGuestFields(),
      renderContentField(
        "reply",
        config.strings.writeReply,
        config.strings.writeReply,
      ),
      renderAttachmentField("reply-attachment"),
      '<div class="wp-loop-form__actions">',
      '<button type="submit" class="wp-loop-submit">',
      contentWithIcon(
        state.busy ? config.strings.saving : config.strings.postReply,
        state.busy ? "update" : "undo",
      ),
      "</button>",
      "</div>",
      "</form>",
    ].join("");
  }

  function renderContentField(editorId, label, placeholder) {
    if (!hasRichTextSupport()) {
      return [
        "<label>",
        escapeHtml(label),
        '<textarea class="wp-loop-textarea" name="content" required></textarea>',
        "</label>",
      ].join("");
    }

    var labelId = "wp-loop-editor-label-" + editorId;
    var toolbarId = "wp-loop-editor-toolbar-" + editorId;

    return [
      '<div class="wp-loop-field">',
      '<div class="wp-loop-field__label" id="',
      escapeAttribute(labelId),
      '">',
      escapeHtml(label),
      "</div>",
      '<div class="wp-loop-rich-text-shell">',
      renderRichTextToolbar(toolbarId),
      '<div class="wp-loop-rich-text" data-rich-text-editor="true" data-editor-id="',
      escapeAttribute(editorId),
      '" data-toolbar-id="',
      escapeAttribute(toolbarId),
      '" data-label-id="',
      escapeAttribute(labelId),
      '" data-placeholder="',
      escapeAttribute(placeholder),
      '"></div>',
      "</div>",
      '<input type="hidden" name="content" value="" />',
      "</div>",
    ].join("");
  }

  function renderRichTextToolbar(toolbarId) {
    return [
      '<div class="wp-loop-rich-text-toolbar" id="',
      escapeAttribute(toolbarId),
      '" aria-label="',
      escapeAttribute(config.strings.formattingToolbar),
      '">',
      '<span class="ql-formats">',
      '<button type="button" class="ql-bold" aria-label="',
      escapeAttribute(config.strings.formatBold),
      '"></button>',
      '<button type="button" class="ql-italic" aria-label="',
      escapeAttribute(config.strings.formatItalic),
      '"></button>',
      '<button type="button" class="ql-underline" aria-label="',
      escapeAttribute(config.strings.formatUnderline),
      '"></button>',
      '<button type="button" class="ql-strike" aria-label="',
      escapeAttribute(config.strings.formatStrike),
      '"></button>',
      "</span>",
      '<span class="ql-formats">',
      '<button type="button" class="ql-list" value="ordered" aria-label="',
      escapeAttribute(config.strings.formatOrderedList),
      '"></button>',
      '<button type="button" class="ql-list" value="bullet" aria-label="',
      escapeAttribute(config.strings.formatBulletList),
      '"></button>',
      "</span>",
      '<span class="ql-formats">',
      '<button type="button" class="ql-blockquote" aria-label="',
      escapeAttribute(config.strings.formatQuote),
      '"></button>',
      '<button type="button" class="ql-code-block" aria-label="',
      escapeAttribute(config.strings.formatCodeBlock),
      '"></button>',
      '<button type="button" class="ql-link" aria-label="',
      escapeAttribute(config.strings.formatLink),
      '"></button>',
      '<button type="button" class="ql-clean" aria-label="',
      escapeAttribute(config.strings.formatClear),
      '"></button>',
      "</span>",
      "</div>",
    ].join("");
  }

  function renderAttachmentField(fieldId) {
    var file = state.attachmentFile;
    var attached = state.pendingAttachment;
    var fileName = file ? file.name : "";
    var isAttached = attached && attached.attachmentUrl;
    var isUploading = state.uploadingAttachment;

    return [
      '<div class="wp-loop-attachment-field" data-attachment-field="',
      escapeAttribute(fieldId),
      '">',
      '<input type="file" id="wp-loop-file-',
      escapeAttribute(fieldId),
      '" class="wp-loop-file-input" ',
      'accept="' +
        (config.upload && config.upload.allowedTypes
          ? Object.keys(config.upload.allowedTypes)
              .map(function (ext) {
                return "." + ext;
              })
              .join(",")
          : "") +
        '" ',
      isAttached || isUploading ? "disabled" : "",
      "/>",
      '<label for="wp-loop-file-',
      escapeAttribute(fieldId),
      '" class="wp-loop-file-label',
      isUploading ? " is-uploading" : "",
      '">',
      iconMarkup("paperclip", "wp-loop-meta-icon"),
      '<span class="wp-loop-file-label__text">',
      isUploading
        ? escapeHtml(config.strings.uploading)
        : isAttached
          ? escapeHtml(config.strings.fileAttached)
          : escapeHtml(config.strings.attachFile),
      "</span>",
      isAttached || file
        ? '<span class="wp-loop-file-label__name">' +
          escapeHtml(
            fileName ||
              (attached ? attached.attachmentUrl.split("/").pop() : ""),
          ) +
          "</span>"
        : "",
      isAttached
        ? '<button type="button" class="wp-loop-inline-button wp-loop-remove-file" data-action="remove-file">' +
          escapeHtml(config.strings.removeFile) +
          "</button>"
        : "",
      isUploading
        ? '<span class="wp-loop-upload-spinner" aria-hidden="true"></span>'
        : "",
      "</label>",
      "</div>",
    ].join("");
  }

  function updateAttachmentField(container) {
    if (!container) {
      return;
    }

    var fieldId = container.getAttribute("data-attachment-field");

    if (!fieldId) {
      return;
    }

    var replacement = document.createElement("div");
    replacement.innerHTML = renderAttachmentField(fieldId);

    if (replacement.firstChild) {
      container.parentNode.replaceChild(replacement.firstChild, container);
    }
  }

  function captureScreenshot(element) {
    state.capturingScreenshot = true;

    var rect = element.getBoundingClientRect();
    var maxDim = 1920;
    var scale = 1;
    if (rect.width > maxDim || rect.height > maxDim) {
      scale = Math.min(maxDim / rect.width, maxDim / rect.height);
    }

    html2canvas(element, { useCORS: true, scale: scale })
      .then(function (canvas) {
        try {
          state.screenshotUri = canvas.toDataURL("image/webp", 0.8);
        } catch (e) {
          state.screenshotUri = canvas.toDataURL("image/jpeg", 0.8);
        }
        state.capturingScreenshot = false;
      })
      .catch(function () {
        state.capturingScreenshot = false;
        showNotice(config.strings.screenshotError || "Screenshot failed", true);
      });
  }

  function renderScreenshotMarkup(uri) {
    if (!uri) {
      return "";
    }

    return [
      '<div class="wp-loop-screenshot-display">',
      '<a href="',
      escapeAttribute(uri),
      '" target="_blank" rel="noopener noreferrer">',
      '<img src="',
      escapeAttribute(uri),
      '" alt="Screenshot" class="wp-loop-screenshot-image" />',
      "</a>",
      "</div>",
    ].join("");
  }

  function renderGuestFields() {
    if (config.currentUser && config.currentUser.isLoggedIn) {
      return "";
    }

    return [
      "<label>",
      escapeHtml(config.strings.guestName),
      '<input class="wp-loop-input" type="text" name="author_name" value="',
      escapeAttribute(state.guestName),
      '" required />',
      "</label>",
      "<label>",
      escapeHtml(config.strings.guestEmail),
      '<input class="wp-loop-input" type="email" name="author_email" value="',
      escapeAttribute(state.guestEmail),
      '" />',
      "</label>",
    ].join("");
  }

  function renderMarkers() {
    var threads = getVisibleThreads();
    refs.markers.innerHTML = threads
      .map(function (thread, index) {
        var position = getAnchorPosition(thread);
        if (!position) {
          return "";
        }

        var deviceClass = "";
        var deviceAttr = "";
        if (thread.deviceContext) {
          var deviceParts = thread.deviceContext.split(":");
          deviceClass =
            " wp-loop-marker--" +
            escapeAttribute(deviceParts[0] || "unknown");
          deviceAttr =
            ' data-device-context="' +
            escapeAttribute(thread.deviceContext) +
            '"';
        }
        var statusClass = "resolved" === thread.status ? " is-resolved" : "";
        return [
          '<button type="button" class="wp-loop-marker',
          statusClass,
          deviceClass,
          '" style="left:',
          String(position.left),
          "px;top:",
          String(position.top),
          'px;"',
          deviceAttr,
          ' data-action="open-thread" data-thread-id="',
          String(thread.id),
          '" aria-label="',
          escapeAttribute(config.strings.viewThread),
          '">',
          String(index + 1),
          "</button>",
        ].join("");
      })
      .join("");
  }

  function handleCommentHover(event) {
    if ("comment" !== state.mode) {
      return;
    }

    var element = getValidTarget(event.target);
    if (!element) {
      state.hoveredElement = null;
      hideHighlight();
      return;
    }

    state.hoveredElement = element;
    updateHighlight();
  }

  function handleCommentClick(event) {
    if ("comment" !== state.mode) {
      return;
    }

    if (state.popoverOpen) {
      return;
    }

    if (root.contains(event.target)) {
      return;
    }

    var element = getValidTarget(event.target);
    if (!element) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();

    state.selectedAnchor = captureAnchor(element, event);
    captureScreenshot(element);
    showPopover(event.clientX, event.clientY);
  }

  function updateHighlight() {
    if (!state.hoveredElement || "comment" !== state.mode) {
      hideHighlight();
      return;
    }

    var rect = state.hoveredElement.getBoundingClientRect();
    refs.highlight.hidden = false;
    refs.highlight.style.top = rect.top + "px";
    refs.highlight.style.left = rect.left + "px";
    refs.highlight.style.width = rect.width + "px";
    refs.highlight.style.height = rect.height + "px";
  }

  function hideHighlight() {
    refs.highlight.hidden = true;
  }

  function showPopover(x, y) {
    if (state.popoverOpen) {
      closePopover();
    }

    state.panelOpen = false;
    state.panelView = "list";
    state.activeThreadId = 0;
    state.mode = "navigate";
    document.body.classList.remove("wp-loop-comment-mode");
    hideHighlight();
    renderToolbar();
    renderPanel();
    renderPopoverContent();
    refs.popover.hidden = false;
    state.popoverOpen = true;
    initRichTextEditorsIn(refs.popover);
    positionPopover(refs.popover, x, y);
  }

  function closePopover() {
    refs.popover.hidden = true;
    refs.popover.innerHTML = "";
    state.popoverOpen = false;
  }

  function cancelCompose() {
    closePopover();
    state.selectedAnchor = null;
    state.replyParentId = 0;
    state.attachmentFile = null;
    state.pendingAttachment = null;
    state.screenshotUri = null;
    state.capturingScreenshot = false;
    state.panelView = "list";
    if (!state.threads.length) {
      state.panelOpen = false;
    }
    state.mode = "navigate";
    document.body.classList.remove("wp-loop-comment-mode");
    hideHighlight();
    hideNotice();
    renderToolbar();
    renderPanel();
  }

  function positionPopover(el, x, y) {
    var margin = 16;
    var offset = 18;

    var elWidth = el.offsetWidth;
    var elHeight = el.offsetHeight;

    var left;
    var spaceRight = window.innerWidth - x - margin;
    var spaceLeft = x - margin;

    if (spaceRight >= elWidth + offset) {
      left = x + offset;
    } else if (spaceLeft >= elWidth + offset) {
      left = x - elWidth - offset;
    } else if (spaceRight > spaceLeft) {
      left = x + offset;
      if (left + elWidth + margin > window.innerWidth) {
        left = window.innerWidth - elWidth - margin;
      }
    } else {
      left = x - elWidth - offset;
      if (left < margin) {
        left = margin;
      }
    }

    var top;
    var spaceBelow = window.innerHeight - y - margin;
    var spaceAbove = y - margin;

    if (spaceBelow >= elHeight + offset) {
      top = y + offset;
    } else if (spaceAbove >= elHeight + offset) {
      top = y - elHeight - offset;
    } else if (spaceBelow > spaceAbove) {
      top = y + offset;
      if (top + elHeight + margin > window.innerHeight) {
        top = window.innerHeight - elHeight - margin;
      }
    } else {
      top = y - elHeight - offset;
      if (top < margin) {
        top = margin;
      }
    }

    left = Math.max(margin, Math.round(left));
    top = Math.max(margin, Math.round(top));

    el.style.left = left + "px";
    el.style.top = top + "px";

    var popoverRect = el.getBoundingClientRect();

    var arrowDir = y < popoverRect.top ? "top" : "bottom";
    el.setAttribute("data-arrow", arrowDir);

    var arrowX = x - popoverRect.left;
    arrowX = Math.max(20, Math.min(arrowX, popoverRect.width - 20));
    el.style.setProperty("--wp-loop-popover-arrow-x", Math.round(arrowX) + "px");
  }

  function renderPopoverContent() {
    refs.popover.innerHTML = [
      '<div class="wp-loop-popover__header">',
      '<h2 class="wp-loop-popover__title">',
      escapeHtml(config.strings.newComment),
      "</h2>",
      iconButtonMarkup("cancel-compose", config.strings.close, "dismiss"),
      "</div>",
      '<div class="wp-loop-composer-meta"><strong>',
      escapeHtml(config.strings.selectElement),
      ":</strong> ",
      escapeHtml(state.selectedAnchor.selector),
      "</div>",
      '<form class="wp-loop-form" data-form="thread">',
      renderGuestFields(),
      renderContentField(
        "thread",
        config.strings.writeComment,
        config.strings.writeComment,
      ),
      renderAttachmentField("thread-attachment"),
      '<div class="wp-loop-form__actions">',
      '<button type="submit" class="wp-loop-submit">',
      contentWithIcon(
        state.busy ? config.strings.saving : config.strings.postComment,
        state.busy ? "update" : "admin-comments",
      ),
      "</button>",
      actionButtonMarkup(
        "wp-loop-ghost-button",
        "cancel-compose",
        config.strings.cancel,
        "dismiss",
        {},
        { iconOnly: true },
      ),
      "</div>",
      "</form>",
    ].join("");
  }

  function captureAnchor(element, event) {
    var rect = element.getBoundingClientRect();
    var anchorX = event.pageX;
    var anchorY = event.pageY;

    return {
      selector: buildSelector(element),
      anchorX: Math.round(anchorX * 100) / 100,
      anchorY: Math.round(anchorY * 100) / 100,
      offsetX: rect.width
        ? roundNumber((event.clientX - rect.left) / rect.width, 4)
        : 0,
      offsetY: rect.height
        ? roundNumber((event.clientY - rect.top) / rect.height, 4)
        : 0,
    };
  }

  function buildSelector(element) {
    if (element.id) {
      return "#" + cssEscape(element.id);
    }

    var path = [];
    var current = element;
    while (current && current.nodeType === 1 && current !== document.body) {
      var segment = current.tagName.toLowerCase();
      var siblingIndex = 1;
      var sibling = current;
      while ((sibling = sibling.previousElementSibling)) {
        if (sibling.tagName === current.tagName) {
          siblingIndex += 1;
        }
      }
      segment += ":nth-of-type(" + siblingIndex + ")";
      path.unshift(segment);
      current = current.parentElement;
    }

    return "body > " + path.join(" > ");
  }

  function getAnchorPosition(thread) {
    var element = null;
    if (thread.selector) {
      try {
        element = document.querySelector(thread.selector);
      } catch (error) {
        element = null;
      }
    }

    if (element) {
      var rect = element.getBoundingClientRect();
      var left =
        window.scrollX + rect.left + rect.width * (thread.offsetX || 0);
      var top = window.scrollY + rect.top + rect.height * (thread.offsetY || 0);
      return { left: roundNumber(left, 2), top: roundNumber(top, 2) };
    }

    if (
      typeof thread.anchorX === "number" &&
      typeof thread.anchorY === "number"
    ) {
      return { left: thread.anchorX, top: thread.anchorY };
    }

    return null;
  }

  function getValidTarget(node) {
    var element =
      node && node.nodeType === 1 ? node : node ? node.parentElement : null;
    while (element) {
      if (root.contains(element)) {
        return null;
      }

      var tagName = element.tagName ? element.tagName.toLowerCase() : "";
      if (
        -1 !==
        [
          "html",
          "body",
          "script",
          "style",
          "meta",
          "link",
          "head",
          "noscript",
        ].indexOf(tagName)
      ) {
        element = element.parentElement;
        continue;
      }

      return element;
    }

    return null;
  }

  function loadThreads() {
    showNotice(config.strings.loading);
    apiRequest(
      "threads?url=" +
        encodeURIComponent(config.pageUrl || window.location.href),
    )
      .then(function (threads) {
        state.threads = Array.isArray(threads) ? threads : [];
        hideNotice();
        renderToolbar();
        renderPanel();
        renderMarkers();
      })
      .catch(function (error) {
        showNotice(error.message || config.strings.networkError, true);
      });
  }

  function uploadFile(file) {
    var body = new FormData();
    body.append("file", file);

    return apiRequest("upload", {
      method: "POST",
      body: body,
    });
  }

  function createThread(formData, editorPayload) {
    if (!state.selectedAnchor) {
      return;
    }

    var content = editorPayload
      ? editorPayload.html
      : (formData.get("content") || "").toString().trim();
    var contentText = editorPayload ? editorPayload.text : content;
    var authorName = (formData.get("author_name") || state.guestName || "")
      .toString()
      .trim();
    var authorEmail = (formData.get("author_email") || state.guestEmail || "")
      .toString()
      .trim();

    if (!contentText) {
      showNotice(config.strings.commentRequired, true);
      return;
    }

    if (!(config.currentUser && config.currentUser.isLoggedIn) && !authorName) {
      showNotice(config.strings.guestNameRequired, true);
      return;
    }

    state.busy = true;

    if (state.popoverOpen) {
      var busyBtn = refs.popover.querySelector(".wp-loop-submit");
      if (busyBtn) { busyBtn.disabled = true; }
    }

    renderPanel();

    var uploadPromise = state.attachmentFile
      ? (function () {
          state.uploadingAttachment = true;
          renderPanel();
          return uploadFile(state.attachmentFile);
        })()
      : Promise.resolve(null);

    uploadPromise
      .then(function (attachment) {
        if (attachment) {
          state.pendingAttachment = {
            attachmentUrl: attachment.attachment_url,
            attachmentId: attachment.attachment_id,
          };
        }

        state.uploadingAttachment = false;

        var attachmentUrl = attachment ? attachment.attachment_url : "";
        var attachmentId = attachment ? attachment.attachment_id : 0;

        return apiRequest("threads", {
          method: "POST",
          body: JSON.stringify({
            page_url: config.pageUrl || window.location.href,
            page_title: document.title || "",
            selector: state.selectedAnchor.selector,
            anchor_x: state.selectedAnchor.anchorX,
            anchor_y: state.selectedAnchor.anchorY,
            offset_x: state.selectedAnchor.offsetX,
            offset_y: state.selectedAnchor.offsetY,
            content: content,
            author_name: authorName,
            author_email: authorEmail,
            attachment_url: attachmentUrl,
            attachment_id: attachmentId,
            screenshot_uri: state.screenshotUri || "",
            device_context: getDeviceContextKey(),
          }),
        });
      })
      .then(function (thread) {
        upsertThread(thread);
        closePopover();
        state.selectedAnchor = null;
        state.attachmentFile = null;
        state.pendingAttachment = null;
        state.screenshotUri = null;
        state.capturingScreenshot = false;
        state.busy = false;
        state.mode = "navigate";
        document.body.classList.remove("wp-loop-comment-mode");
        state.activeThreadId = 0;
        state.panelView = "list";
        state.panelOpen = true;
        showNotice(config.strings.commentSaved);
        renderToolbar();
        renderPanel();
        renderMarkers();
      })
      .catch(function (error) {
        state.busy = false;
        state.uploadingAttachment = false;
        if (state.popoverOpen) {
          var errBtn = refs.popover.querySelector(".wp-loop-submit");
          if (errBtn) { errBtn.disabled = false; }
        }
        showNotice(error.message || config.strings.networkError, true);
        renderPanel();
      });
  }

  function createReply(formData, editorPayload) {
    var thread = getActiveThread();
    if (!thread) {
      return;
    }

    var content = editorPayload
      ? editorPayload.html
      : (formData.get("content") || "").toString().trim();
    var contentText = editorPayload ? editorPayload.text : content;
    var authorName = (formData.get("author_name") || state.guestName || "")
      .toString()
      .trim();
    var authorEmail = (formData.get("author_email") || state.guestEmail || "")
      .toString()
      .trim();

    if (!contentText) {
      showNotice(config.strings.commentRequired, true);
      return;
    }

    if (!(config.currentUser && config.currentUser.isLoggedIn) && !authorName) {
      showNotice(config.strings.guestNameRequired, true);
      return;
    }

    state.busy = true;
    renderPanel();

    var uploadPromise = state.attachmentFile
      ? (function () {
          state.uploadingAttachment = true;
          renderPanel();
          return uploadFile(state.attachmentFile);
        })()
      : Promise.resolve(null);

    uploadPromise
      .then(function (attachment) {
        if (attachment) {
          state.pendingAttachment = {
            attachmentUrl: attachment.attachment_url,
            attachmentId: attachment.attachment_id,
          };
        }

        state.uploadingAttachment = false;

        var attachmentUrl = attachment ? attachment.attachment_url : "";
        var attachmentId = attachment ? attachment.attachment_id : 0;

        return apiRequest("threads/" + thread.id + "/replies", {
          method: "POST",
          body: JSON.stringify({
            content: content,
            parent_reply_id: state.replyParentId,
            author_name: authorName,
            author_email: authorEmail,
            attachment_url: attachmentUrl,
            attachment_id: attachmentId,
            screenshot_uri: state.screenshotUri || "",
          }),
        });
      })
      .then(function (updatedThread) {
        upsertThread(updatedThread);
        state.busy = false;
        state.replyParentId = 0;
        state.attachmentFile = null;
        state.pendingAttachment = null;
        state.screenshotUri = null;
        state.capturingScreenshot = false;
        showNotice(config.strings.replySaved);
        renderToolbar();
        renderPanel();
      })
      .catch(function (error) {
        state.busy = false;
        state.uploadingAttachment = false;
        showNotice(error.message || config.strings.networkError, true);
        renderPanel();
      });
  }

  function resolveThread(threadId) {
    var thread = getThreadById(threadId);
    if (!thread || !thread.canResolve) {
      showNotice(config.strings.cannotResolve, true);
      return;
    }

    apiRequest("threads/" + threadId + "/resolve", {
      method: "POST",
      body: JSON.stringify({}),
    })
      .then(function (updatedThread) {
        upsertThread(updatedThread);
        showNotice(config.strings.resolvedSaved);
        renderToolbar();
        renderPanel();
        renderMarkers();
      })
      .catch(function (error) {
        showNotice(error.message || config.strings.networkError, true);
      });
  }

  function apiRequest(path, options) {
    options = options || {};
    var requestOptions = {
      method: options.method || "GET",
      headers: options.headers || {},
      credentials: "same-origin",
    };

    requestOptions.headers["X-WP-Nonce"] = config.nonce;
    requestOptions.headers["X-WP-Loop-Nonce"] =
      config.actionNonce || config.legacyNonce || config.nonce;
    requestOptions.headers["X-CM-Visual-Feedback-Widget-Nonce"] =
      config.actionNonce || config.legacyNonce || config.nonce;
    requestOptions.headers.Accept = "application/json";

    if (options.body) {
      if (options.body instanceof FormData) {
        requestOptions.body = options.body;
      } else {
        requestOptions.headers["Content-Type"] = "application/json";
        requestOptions.body = options.body;
      }
    }

    return window
      .fetch(config.restUrl + path, requestOptions)
      .then(function (response) {
        return response
          .json()
          .catch(function () {
            return {};
          })
          .then(function (data) {
            if (!response.ok) {
              throw new Error(data.message || config.strings.networkError);
            }
            return data;
          });
      });
  }

  function upsertThread(thread) {
    var replaced = false;
    state.threads = state.threads.map(function (item) {
      if (item.id === thread.id) {
        replaced = true;
        return thread;
      }
      return item;
    });

    if (!replaced) {
      state.threads.push(thread);
    }
  }

  function getVisibleThreads() {
    var deviceKey = getDeviceContextKey();
    return state.threads.filter(function (thread) {
      if (!state.showResolved && "resolved" === thread.status) {
        return false;
      }
      if (!state.deviceMode) {
        return !thread.deviceContext;
      }
      return thread.deviceContext === deviceKey;
    });
  }

  function getThreadById(id) {
    return (
      state.threads.find(function (thread) {
        return thread.id === id;
      }) || null
    );
  }

  function getActiveThread() {
    return getThreadById(state.activeThreadId);
  }

  function findReplyById(replies, id) {
    for (var i = 0; i < replies.length; i += 1) {
      if (replies[i].id === id) {
        return replies[i];
      }
      if (replies[i].children && replies[i].children.length) {
        var nested = findReplyById(replies[i].children, id);
        if (nested) {
          return nested;
        }
      }
    }
    return null;
  }

  function countReplies(replies) {
    return replies.reduce(function (total, reply) {
      return total + 1 + countReplies(reply.children || []);
    }, 0);
  }

  function showNotice(message, isError) {
    if (noticeTimer) {
      clearTimeout(noticeTimer);
      noticeTimer = null;
    }
    state.notice = { message: message, isError: !!isError };
    refs.notice.classList.remove("wp-loop-hidden");
    refs.notice.classList.toggle("is-error", !!isError);
    refs.notice.textContent = message;
    if (!isError) {
      noticeTimer = setTimeout(hideNotice, 5000);
    }
  }

  function hideNotice() {
    if (noticeTimer) {
      clearTimeout(noticeTimer);
      noticeTimer = null;
    }
    state.notice = null;
    refs.notice.textContent = "";
    refs.notice.classList.add("wp-loop-hidden");
    refs.notice.classList.remove("is-error");
  }

  function hasRichTextSupport() {
    return "function" === typeof window.Quill;
  }

  function initializeRichTextEditors(container) {
    if (container) {
      initRichTextEditorsIn(container);
      return;
    }

    refs.richTextEditors = {};
    initRichTextEditorsIn(refs.panel);
  }

  function initRichTextEditorsIn(container) {
    if (!hasRichTextSupport() || !container) {
      return;
    }

    Array.prototype.forEach.call(
      container.querySelectorAll("[data-rich-text-editor]"),
      function (editorElement) {
        var editorId = editorElement.getAttribute("data-editor-id") || "";
        var toolbarId = editorElement.getAttribute("data-toolbar-id") || "";
        var labelId = editorElement.getAttribute("data-label-id") || "";
        var placeholder = editorElement.getAttribute("data-placeholder") || "";
        var hiddenInput = editorElement
          .closest(".wp-loop-field")
          .querySelector('input[name="content"]');
        var quill = new window.Quill(editorElement, {
          theme: "snow",
          placeholder: placeholder,
          modules: {
            toolbar: "#" + cssEscape(toolbarId),
            history: {
              userOnly: true,
            },
          },
        });
        var editorRoot = editorElement.querySelector(".ql-editor");

        if (editorRoot) {
          editorRoot.setAttribute("aria-labelledby", labelId);
          editorRoot.setAttribute("aria-multiline", "true");
        }

        if (hiddenInput) {
          hiddenInput.value = getRichTextHtml(quill);
        }

        quill.on("text-change", function () {
          if (hiddenInput) {
            hiddenInput.value = getRichTextHtml(quill);
          }
        });

        refs.richTextEditors[editorId] = quill;
      },
    );
  }

  function getEditorPayload(form) {
    if (!form || !hasRichTextSupport()) {
      return null;
    }

    var editorElement = form.querySelector("[data-rich-text-editor]");

    if (!editorElement) {
      return null;
    }

    var editorId = editorElement.getAttribute("data-editor-id") || "";
    var quill = refs.richTextEditors[editorId];

    if (!quill) {
      return null;
    }

    var html = getRichTextHtml(quill);
    var text = getRichTextText(quill);
    var hiddenInput = form.querySelector('input[name="content"]');

    if (hiddenInput) {
      hiddenInput.value = html;
    }

    return {
      html: html,
      text: text,
    };
  }

  function getRichTextHtml(quill) {
    return getRichTextText(quill) ? quill.root.innerHTML : "";
  }

  function getRichTextText(quill) {
    return String(quill.getText() || "")
      .replace(/\u00a0/g, " ")
      .trim();
  }

  function renderAttachmentMarkup(attachmentUrl, attachmentId) {
    if (!attachmentUrl) {
      return "";
    }

    var isImage = /\.(jpg|jpeg|png|gif|webp|svg)(\?|$)/i.test(attachmentUrl);
    var label = isImage
      ? config.strings.viewAttachment
      : config.strings.downloadAttachment;
    var className = "wp-loop-attachment";

    if (isImage) {
      return [
        '<div class="',
        className,
        " ",
        className,
        '--image">',
        '<a href="',
        escapeAttribute(attachmentUrl),
        '" target="_blank" rel="noopener noreferrer">',
        '<img src="',
        escapeAttribute(attachmentUrl),
        '" alt="',
        escapeAttribute(label),
        '" loading="lazy" />',
        "</a>",
        "</div>",
      ].join("");
    }

    return [
      '<div class="',
      className,
      " ",
      className,
      '--file">',
      iconMarkup("media-document", "wp-loop-meta-icon"),
      '<a href="',
      escapeAttribute(attachmentUrl),
      '" target="_blank" rel="noopener noreferrer">',
      escapeHtml(label),
      "</a>",
      "</div>",
    ].join("");
  }

  function renderCommentContentMarkup(content, contentIsHtml, className) {
    var html = contentIsHtml
      ? String(content || "")
      : escapeHtml(content).replace(/\n/g, "<br>");

    return '<div class="' + escapeAttribute(className) + '">' + html + "</div>";
  }

  function getCommentExcerpt(content, contentIsHtml) {
    var text = getCommentPlainText(content, contentIsHtml);

    return text.length > 120 ? text.slice(0, 117) + "…" : text;
  }

  function getCommentPlainText(content, contentIsHtml) {
    if (!content) {
      return "";
    }

    if (!contentIsHtml) {
      return String(content)
        .replace(/\u00a0/g, " ")
        .replace(/\s+/g, " ")
        .trim();
    }

    var temporaryContainer = document.createElement("div");
    temporaryContainer.innerHTML = String(content);

    return String(
      temporaryContainer.textContent || temporaryContainer.innerText || "",
    )
      .replace(/\u00a0/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function formatDate(value) {
    try {
      return new Intl.DateTimeFormat(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
      }).format(new Date(value));
    } catch (error) {
      return value;
    }
  }

  function cssEscape(value) {
    if (window.CSS && window.CSS.escape) {
      return window.CSS.escape(value);
    }
    return value.replace(/([^a-zA-Z0-9_-])/g, "\\$1");
  }

  function roundNumber(number, decimals) {
    var factor = Math.pow(10, decimals);
    return Math.round(number * factor) / factor;
  }

  function escapeHtml(value) {
    return String(value || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function escapeAttribute(value) {
    return escapeHtml(value);
  }

  function iconMarkup(name, extraClass) {
    return (
      '<span class="dashicons dashicons-' +
      escapeAttribute(name) +
      (extraClass ? " " + escapeAttribute(extraClass) : "") +
      '" aria-hidden="true"></span>'
    );
  }

  function contentWithIcon(label, icon, iconOnly) {
    return (
      iconMarkup(icon, "wp-loop-button__icon") +
      '<span class="wp-loop-button__label' +
      (iconOnly ? " wp-loop-button__label--sr" : "") +
      '">' +
      escapeHtml(label) +
      "</span>"
    );
  }

  function buildDataAttributes(action, data) {
    var attrs = ' data-action="' + escapeAttribute(action) + '"';
    Object.keys(data || {}).forEach(function (key) {
      attrs +=
        " data-" +
        key.replace(/[A-Z]/g, function (char) {
          return "-" + char.toLowerCase();
        }) +
        '="' +
        escapeAttribute(data[key]) +
        '"';
    });
    return attrs;
  }

  function actionButtonMarkup(className, action, label, icon, data, options) {
    options = options || {};
    var classes = className;
    var attributeMarkup = "";

    if (options.active) {
      classes += " is-active";
    }
    if (options.iconOnly) {
      classes += " " + className + "--icon-only wp-loop-has-tooltip";
    }
    if (options.extraClass) {
      classes += " " + options.extraClass;
    }
    if ("boolean" === typeof options.pressed) {
      attributeMarkup +=
        ' aria-pressed="' + (options.pressed ? "true" : "false") + '"';
    }
    if ("boolean" === typeof options.expanded) {
      attributeMarkup +=
        ' aria-expanded="' + (options.expanded ? "true" : "false") + '"';
    }

    return (
      '<button type="button" class="' +
      classes +
      '"' +
      buildDataAttributes(action, data || {}) +
      ' aria-label="' +
      escapeAttribute(label) +
      '"' +
      attributeMarkup +
      (options.iconOnly
        ? ' data-tooltip="' + escapeAttribute(label) + '"'
        : "") +
      ">" +
      (icon
        ? contentWithIcon(label, icon, !!options.iconOnly)
        : escapeHtml(label)) +
      (typeof options.count !== "undefined"
        ? '<span class="wp-loop-toolbar__count">' +
          String(options.count) +
          "</span>"
        : "") +
      "</button>"
    );
  }

  function iconButtonMarkup(action, label, icon) {
    return actionButtonMarkup(
      "wp-loop-icon-button",
      action,
      label,
      icon,
      {},
      { iconOnly: true },
    );
  }

  function buttonMarkup(label, action, active, data, icon, options) {
    options = options || {};
    options.active = active;
    options.pressed = active;
    return actionButtonMarkup(
      "wp-loop-button",
      action,
      label,
      icon,
      data,
      options,
    );
  }
})();
