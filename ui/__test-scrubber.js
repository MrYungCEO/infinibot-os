"use strict";
(() => {
  var __defProp = Object.defineProperty;
  var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
  var __decorateClass = (decorators, target, key, kind) => {
    var result = kind > 1 ? void 0 : kind ? __getOwnPropDesc(target, key) : target;
    for (var i6 = decorators.length - 1, decorator; i6 >= 0; i6--)
      if (decorator = decorators[i6])
        result = (kind ? decorator(target, key, result) : decorator(result)) || result;
    if (kind && result) __defProp(target, key, result);
    return result;
  };

  // ../node_modules/.pnpm/@lit+reactive-element@2.1.2/node_modules/@lit/reactive-element/css-tag.js
  var t = globalThis;
  var e = t.ShadowRoot && (void 0 === t.ShadyCSS || t.ShadyCSS.nativeShadow) && "adoptedStyleSheets" in Document.prototype && "replace" in CSSStyleSheet.prototype;
  var s = /* @__PURE__ */ Symbol();
  var o = /* @__PURE__ */ new WeakMap();
  var n = class {
    constructor(t5, e6, o7) {
      if (this._$cssResult$ = true, o7 !== s) throw Error("CSSResult is not constructable. Use `unsafeCSS` or `css` instead.");
      this.cssText = t5, this.t = e6;
    }
    get styleSheet() {
      let t5 = this.o;
      const s5 = this.t;
      if (e && void 0 === t5) {
        const e6 = void 0 !== s5 && 1 === s5.length;
        e6 && (t5 = o.get(s5)), void 0 === t5 && ((this.o = t5 = new CSSStyleSheet()).replaceSync(this.cssText), e6 && o.set(s5, t5));
      }
      return t5;
    }
    toString() {
      return this.cssText;
    }
  };
  var r = (t5) => new n("string" == typeof t5 ? t5 : t5 + "", void 0, s);
  var i = (t5, ...e6) => {
    const o7 = 1 === t5.length ? t5[0] : e6.reduce((e7, s5, o8) => e7 + ((t6) => {
      if (true === t6._$cssResult$) return t6.cssText;
      if ("number" == typeof t6) return t6;
      throw Error("Value passed to 'css' function must be a 'css' function result: " + t6 + ". Use 'unsafeCSS' to pass non-literal values, but take care to ensure page security.");
    })(s5) + t5[o8 + 1], t5[0]);
    return new n(o7, t5, s);
  };
  var S = (s5, o7) => {
    if (e) s5.adoptedStyleSheets = o7.map((t5) => t5 instanceof CSSStyleSheet ? t5 : t5.styleSheet);
    else for (const e6 of o7) {
      const o8 = document.createElement("style"), n6 = t.litNonce;
      void 0 !== n6 && o8.setAttribute("nonce", n6), o8.textContent = e6.cssText, s5.appendChild(o8);
    }
  };
  var c = e ? (t5) => t5 : (t5) => t5 instanceof CSSStyleSheet ? ((t6) => {
    let e6 = "";
    for (const s5 of t6.cssRules) e6 += s5.cssText;
    return r(e6);
  })(t5) : t5;

  // ../node_modules/.pnpm/@lit+reactive-element@2.1.2/node_modules/@lit/reactive-element/reactive-element.js
  var { is: i2, defineProperty: e2, getOwnPropertyDescriptor: h, getOwnPropertyNames: r2, getOwnPropertySymbols: o2, getPrototypeOf: n2 } = Object;
  var a = globalThis;
  var c2 = a.trustedTypes;
  var l = c2 ? c2.emptyScript : "";
  var p = a.reactiveElementPolyfillSupport;
  var d = (t5, s5) => t5;
  var u = { toAttribute(t5, s5) {
    switch (s5) {
      case Boolean:
        t5 = t5 ? l : null;
        break;
      case Object:
      case Array:
        t5 = null == t5 ? t5 : JSON.stringify(t5);
    }
    return t5;
  }, fromAttribute(t5, s5) {
    let i6 = t5;
    switch (s5) {
      case Boolean:
        i6 = null !== t5;
        break;
      case Number:
        i6 = null === t5 ? null : Number(t5);
        break;
      case Object:
      case Array:
        try {
          i6 = JSON.parse(t5);
        } catch (t6) {
          i6 = null;
        }
    }
    return i6;
  } };
  var f = (t5, s5) => !i2(t5, s5);
  var b = { attribute: true, type: String, converter: u, reflect: false, useDefault: false, hasChanged: f };
  Symbol.metadata ??= /* @__PURE__ */ Symbol("metadata"), a.litPropertyMetadata ??= /* @__PURE__ */ new WeakMap();
  var y = class extends HTMLElement {
    static addInitializer(t5) {
      this._$Ei(), (this.l ??= []).push(t5);
    }
    static get observedAttributes() {
      return this.finalize(), this._$Eh && [...this._$Eh.keys()];
    }
    static createProperty(t5, s5 = b) {
      if (s5.state && (s5.attribute = false), this._$Ei(), this.prototype.hasOwnProperty(t5) && ((s5 = Object.create(s5)).wrapped = true), this.elementProperties.set(t5, s5), !s5.noAccessor) {
        const i6 = /* @__PURE__ */ Symbol(), h4 = this.getPropertyDescriptor(t5, i6, s5);
        void 0 !== h4 && e2(this.prototype, t5, h4);
      }
    }
    static getPropertyDescriptor(t5, s5, i6) {
      const { get: e6, set: r7 } = h(this.prototype, t5) ?? { get() {
        return this[s5];
      }, set(t6) {
        this[s5] = t6;
      } };
      return { get: e6, set(s6) {
        const h4 = e6?.call(this);
        r7?.call(this, s6), this.requestUpdate(t5, h4, i6);
      }, configurable: true, enumerable: true };
    }
    static getPropertyOptions(t5) {
      return this.elementProperties.get(t5) ?? b;
    }
    static _$Ei() {
      if (this.hasOwnProperty(d("elementProperties"))) return;
      const t5 = n2(this);
      t5.finalize(), void 0 !== t5.l && (this.l = [...t5.l]), this.elementProperties = new Map(t5.elementProperties);
    }
    static finalize() {
      if (this.hasOwnProperty(d("finalized"))) return;
      if (this.finalized = true, this._$Ei(), this.hasOwnProperty(d("properties"))) {
        const t6 = this.properties, s5 = [...r2(t6), ...o2(t6)];
        for (const i6 of s5) this.createProperty(i6, t6[i6]);
      }
      const t5 = this[Symbol.metadata];
      if (null !== t5) {
        const s5 = litPropertyMetadata.get(t5);
        if (void 0 !== s5) for (const [t6, i6] of s5) this.elementProperties.set(t6, i6);
      }
      this._$Eh = /* @__PURE__ */ new Map();
      for (const [t6, s5] of this.elementProperties) {
        const i6 = this._$Eu(t6, s5);
        void 0 !== i6 && this._$Eh.set(i6, t6);
      }
      this.elementStyles = this.finalizeStyles(this.styles);
    }
    static finalizeStyles(s5) {
      const i6 = [];
      if (Array.isArray(s5)) {
        const e6 = new Set(s5.flat(1 / 0).reverse());
        for (const s6 of e6) i6.unshift(c(s6));
      } else void 0 !== s5 && i6.push(c(s5));
      return i6;
    }
    static _$Eu(t5, s5) {
      const i6 = s5.attribute;
      return false === i6 ? void 0 : "string" == typeof i6 ? i6 : "string" == typeof t5 ? t5.toLowerCase() : void 0;
    }
    constructor() {
      super(), this._$Ep = void 0, this.isUpdatePending = false, this.hasUpdated = false, this._$Em = null, this._$Ev();
    }
    _$Ev() {
      this._$ES = new Promise((t5) => this.enableUpdating = t5), this._$AL = /* @__PURE__ */ new Map(), this._$E_(), this.requestUpdate(), this.constructor.l?.forEach((t5) => t5(this));
    }
    addController(t5) {
      (this._$EO ??= /* @__PURE__ */ new Set()).add(t5), void 0 !== this.renderRoot && this.isConnected && t5.hostConnected?.();
    }
    removeController(t5) {
      this._$EO?.delete(t5);
    }
    _$E_() {
      const t5 = /* @__PURE__ */ new Map(), s5 = this.constructor.elementProperties;
      for (const i6 of s5.keys()) this.hasOwnProperty(i6) && (t5.set(i6, this[i6]), delete this[i6]);
      t5.size > 0 && (this._$Ep = t5);
    }
    createRenderRoot() {
      const t5 = this.shadowRoot ?? this.attachShadow(this.constructor.shadowRootOptions);
      return S(t5, this.constructor.elementStyles), t5;
    }
    connectedCallback() {
      this.renderRoot ??= this.createRenderRoot(), this.enableUpdating(true), this._$EO?.forEach((t5) => t5.hostConnected?.());
    }
    enableUpdating(t5) {
    }
    disconnectedCallback() {
      this._$EO?.forEach((t5) => t5.hostDisconnected?.());
    }
    attributeChangedCallback(t5, s5, i6) {
      this._$AK(t5, i6);
    }
    _$ET(t5, s5) {
      const i6 = this.constructor.elementProperties.get(t5), e6 = this.constructor._$Eu(t5, i6);
      if (void 0 !== e6 && true === i6.reflect) {
        const h4 = (void 0 !== i6.converter?.toAttribute ? i6.converter : u).toAttribute(s5, i6.type);
        this._$Em = t5, null == h4 ? this.removeAttribute(e6) : this.setAttribute(e6, h4), this._$Em = null;
      }
    }
    _$AK(t5, s5) {
      const i6 = this.constructor, e6 = i6._$Eh.get(t5);
      if (void 0 !== e6 && this._$Em !== e6) {
        const t6 = i6.getPropertyOptions(e6), h4 = "function" == typeof t6.converter ? { fromAttribute: t6.converter } : void 0 !== t6.converter?.fromAttribute ? t6.converter : u;
        this._$Em = e6;
        const r7 = h4.fromAttribute(s5, t6.type);
        this[e6] = r7 ?? this._$Ej?.get(e6) ?? r7, this._$Em = null;
      }
    }
    requestUpdate(t5, s5, i6, e6 = false, h4) {
      if (void 0 !== t5) {
        const r7 = this.constructor;
        if (false === e6 && (h4 = this[t5]), i6 ??= r7.getPropertyOptions(t5), !((i6.hasChanged ?? f)(h4, s5) || i6.useDefault && i6.reflect && h4 === this._$Ej?.get(t5) && !this.hasAttribute(r7._$Eu(t5, i6)))) return;
        this.C(t5, s5, i6);
      }
      false === this.isUpdatePending && (this._$ES = this._$EP());
    }
    C(t5, s5, { useDefault: i6, reflect: e6, wrapped: h4 }, r7) {
      i6 && !(this._$Ej ??= /* @__PURE__ */ new Map()).has(t5) && (this._$Ej.set(t5, r7 ?? s5 ?? this[t5]), true !== h4 || void 0 !== r7) || (this._$AL.has(t5) || (this.hasUpdated || i6 || (s5 = void 0), this._$AL.set(t5, s5)), true === e6 && this._$Em !== t5 && (this._$Eq ??= /* @__PURE__ */ new Set()).add(t5));
    }
    async _$EP() {
      this.isUpdatePending = true;
      try {
        await this._$ES;
      } catch (t6) {
        Promise.reject(t6);
      }
      const t5 = this.scheduleUpdate();
      return null != t5 && await t5, !this.isUpdatePending;
    }
    scheduleUpdate() {
      return this.performUpdate();
    }
    performUpdate() {
      if (!this.isUpdatePending) return;
      if (!this.hasUpdated) {
        if (this.renderRoot ??= this.createRenderRoot(), this._$Ep) {
          for (const [t7, s6] of this._$Ep) this[t7] = s6;
          this._$Ep = void 0;
        }
        const t6 = this.constructor.elementProperties;
        if (t6.size > 0) for (const [s6, i6] of t6) {
          const { wrapped: t7 } = i6, e6 = this[s6];
          true !== t7 || this._$AL.has(s6) || void 0 === e6 || this.C(s6, void 0, i6, e6);
        }
      }
      let t5 = false;
      const s5 = this._$AL;
      try {
        t5 = this.shouldUpdate(s5), t5 ? (this.willUpdate(s5), this._$EO?.forEach((t6) => t6.hostUpdate?.()), this.update(s5)) : this._$EM();
      } catch (s6) {
        throw t5 = false, this._$EM(), s6;
      }
      t5 && this._$AE(s5);
    }
    willUpdate(t5) {
    }
    _$AE(t5) {
      this._$EO?.forEach((t6) => t6.hostUpdated?.()), this.hasUpdated || (this.hasUpdated = true, this.firstUpdated(t5)), this.updated(t5);
    }
    _$EM() {
      this._$AL = /* @__PURE__ */ new Map(), this.isUpdatePending = false;
    }
    get updateComplete() {
      return this.getUpdateComplete();
    }
    getUpdateComplete() {
      return this._$ES;
    }
    shouldUpdate(t5) {
      return true;
    }
    update(t5) {
      this._$Eq &&= this._$Eq.forEach((t6) => this._$ET(t6, this[t6])), this._$EM();
    }
    updated(t5) {
    }
    firstUpdated(t5) {
    }
  };
  y.elementStyles = [], y.shadowRootOptions = { mode: "open" }, y[d("elementProperties")] = /* @__PURE__ */ new Map(), y[d("finalized")] = /* @__PURE__ */ new Map(), p?.({ ReactiveElement: y }), (a.reactiveElementVersions ??= []).push("2.1.2");

  // ../node_modules/.pnpm/lit-html@3.3.2/node_modules/lit-html/lit-html.js
  var t2 = globalThis;
  var i3 = (t5) => t5;
  var s2 = t2.trustedTypes;
  var e3 = s2 ? s2.createPolicy("lit-html", { createHTML: (t5) => t5 }) : void 0;
  var h2 = "$lit$";
  var o3 = `lit$${Math.random().toFixed(9).slice(2)}$`;
  var n3 = "?" + o3;
  var r3 = `<${n3}>`;
  var l2 = document;
  var c3 = () => l2.createComment("");
  var a2 = (t5) => null === t5 || "object" != typeof t5 && "function" != typeof t5;
  var u2 = Array.isArray;
  var d2 = (t5) => u2(t5) || "function" == typeof t5?.[Symbol.iterator];
  var f2 = "[ 	\n\f\r]";
  var v = /<(?:(!--|\/[^a-zA-Z])|(\/?[a-zA-Z][^>\s]*)|(\/?$))/g;
  var _ = /-->/g;
  var m = />/g;
  var p2 = RegExp(`>|${f2}(?:([^\\s"'>=/]+)(${f2}*=${f2}*(?:[^ 	
\f\r"'\`<>=]|("|')|))|$)`, "g");
  var g = /'/g;
  var $ = /"/g;
  var y2 = /^(?:script|style|textarea|title)$/i;
  var x = (t5) => (i6, ...s5) => ({ _$litType$: t5, strings: i6, values: s5 });
  var b2 = x(1);
  var w = x(2);
  var T = x(3);
  var E = /* @__PURE__ */ Symbol.for("lit-noChange");
  var A = /* @__PURE__ */ Symbol.for("lit-nothing");
  var C = /* @__PURE__ */ new WeakMap();
  var P = l2.createTreeWalker(l2, 129);
  function V(t5, i6) {
    if (!u2(t5) || !t5.hasOwnProperty("raw")) throw Error("invalid template strings array");
    return void 0 !== e3 ? e3.createHTML(i6) : i6;
  }
  var N = (t5, i6) => {
    const s5 = t5.length - 1, e6 = [];
    let n6, l4 = 2 === i6 ? "<svg>" : 3 === i6 ? "<math>" : "", c5 = v;
    for (let i7 = 0; i7 < s5; i7++) {
      const s6 = t5[i7];
      let a4, u4, d4 = -1, f4 = 0;
      for (; f4 < s6.length && (c5.lastIndex = f4, u4 = c5.exec(s6), null !== u4); ) f4 = c5.lastIndex, c5 === v ? "!--" === u4[1] ? c5 = _ : void 0 !== u4[1] ? c5 = m : void 0 !== u4[2] ? (y2.test(u4[2]) && (n6 = RegExp("</" + u4[2], "g")), c5 = p2) : void 0 !== u4[3] && (c5 = p2) : c5 === p2 ? ">" === u4[0] ? (c5 = n6 ?? v, d4 = -1) : void 0 === u4[1] ? d4 = -2 : (d4 = c5.lastIndex - u4[2].length, a4 = u4[1], c5 = void 0 === u4[3] ? p2 : '"' === u4[3] ? $ : g) : c5 === $ || c5 === g ? c5 = p2 : c5 === _ || c5 === m ? c5 = v : (c5 = p2, n6 = void 0);
      const x3 = c5 === p2 && t5[i7 + 1].startsWith("/>") ? " " : "";
      l4 += c5 === v ? s6 + r3 : d4 >= 0 ? (e6.push(a4), s6.slice(0, d4) + h2 + s6.slice(d4) + o3 + x3) : s6 + o3 + (-2 === d4 ? i7 : x3);
    }
    return [V(t5, l4 + (t5[s5] || "<?>") + (2 === i6 ? "</svg>" : 3 === i6 ? "</math>" : "")), e6];
  };
  var S2 = class _S {
    constructor({ strings: t5, _$litType$: i6 }, e6) {
      let r7;
      this.parts = [];
      let l4 = 0, a4 = 0;
      const u4 = t5.length - 1, d4 = this.parts, [f4, v3] = N(t5, i6);
      if (this.el = _S.createElement(f4, e6), P.currentNode = this.el.content, 2 === i6 || 3 === i6) {
        const t6 = this.el.content.firstChild;
        t6.replaceWith(...t6.childNodes);
      }
      for (; null !== (r7 = P.nextNode()) && d4.length < u4; ) {
        if (1 === r7.nodeType) {
          if (r7.hasAttributes()) for (const t6 of r7.getAttributeNames()) if (t6.endsWith(h2)) {
            const i7 = v3[a4++], s5 = r7.getAttribute(t6).split(o3), e7 = /([.?@])?(.*)/.exec(i7);
            d4.push({ type: 1, index: l4, name: e7[2], strings: s5, ctor: "." === e7[1] ? I : "?" === e7[1] ? L : "@" === e7[1] ? z : H }), r7.removeAttribute(t6);
          } else t6.startsWith(o3) && (d4.push({ type: 6, index: l4 }), r7.removeAttribute(t6));
          if (y2.test(r7.tagName)) {
            const t6 = r7.textContent.split(o3), i7 = t6.length - 1;
            if (i7 > 0) {
              r7.textContent = s2 ? s2.emptyScript : "";
              for (let s5 = 0; s5 < i7; s5++) r7.append(t6[s5], c3()), P.nextNode(), d4.push({ type: 2, index: ++l4 });
              r7.append(t6[i7], c3());
            }
          }
        } else if (8 === r7.nodeType) if (r7.data === n3) d4.push({ type: 2, index: l4 });
        else {
          let t6 = -1;
          for (; -1 !== (t6 = r7.data.indexOf(o3, t6 + 1)); ) d4.push({ type: 7, index: l4 }), t6 += o3.length - 1;
        }
        l4++;
      }
    }
    static createElement(t5, i6) {
      const s5 = l2.createElement("template");
      return s5.innerHTML = t5, s5;
    }
  };
  function M(t5, i6, s5 = t5, e6) {
    if (i6 === E) return i6;
    let h4 = void 0 !== e6 ? s5._$Co?.[e6] : s5._$Cl;
    const o7 = a2(i6) ? void 0 : i6._$litDirective$;
    return h4?.constructor !== o7 && (h4?._$AO?.(false), void 0 === o7 ? h4 = void 0 : (h4 = new o7(t5), h4._$AT(t5, s5, e6)), void 0 !== e6 ? (s5._$Co ??= [])[e6] = h4 : s5._$Cl = h4), void 0 !== h4 && (i6 = M(t5, h4._$AS(t5, i6.values), h4, e6)), i6;
  }
  var R = class {
    constructor(t5, i6) {
      this._$AV = [], this._$AN = void 0, this._$AD = t5, this._$AM = i6;
    }
    get parentNode() {
      return this._$AM.parentNode;
    }
    get _$AU() {
      return this._$AM._$AU;
    }
    u(t5) {
      const { el: { content: i6 }, parts: s5 } = this._$AD, e6 = (t5?.creationScope ?? l2).importNode(i6, true);
      P.currentNode = e6;
      let h4 = P.nextNode(), o7 = 0, n6 = 0, r7 = s5[0];
      for (; void 0 !== r7; ) {
        if (o7 === r7.index) {
          let i7;
          2 === r7.type ? i7 = new k(h4, h4.nextSibling, this, t5) : 1 === r7.type ? i7 = new r7.ctor(h4, r7.name, r7.strings, this, t5) : 6 === r7.type && (i7 = new Z(h4, this, t5)), this._$AV.push(i7), r7 = s5[++n6];
        }
        o7 !== r7?.index && (h4 = P.nextNode(), o7++);
      }
      return P.currentNode = l2, e6;
    }
    p(t5) {
      let i6 = 0;
      for (const s5 of this._$AV) void 0 !== s5 && (void 0 !== s5.strings ? (s5._$AI(t5, s5, i6), i6 += s5.strings.length - 2) : s5._$AI(t5[i6])), i6++;
    }
  };
  var k = class _k {
    get _$AU() {
      return this._$AM?._$AU ?? this._$Cv;
    }
    constructor(t5, i6, s5, e6) {
      this.type = 2, this._$AH = A, this._$AN = void 0, this._$AA = t5, this._$AB = i6, this._$AM = s5, this.options = e6, this._$Cv = e6?.isConnected ?? true;
    }
    get parentNode() {
      let t5 = this._$AA.parentNode;
      const i6 = this._$AM;
      return void 0 !== i6 && 11 === t5?.nodeType && (t5 = i6.parentNode), t5;
    }
    get startNode() {
      return this._$AA;
    }
    get endNode() {
      return this._$AB;
    }
    _$AI(t5, i6 = this) {
      t5 = M(this, t5, i6), a2(t5) ? t5 === A || null == t5 || "" === t5 ? (this._$AH !== A && this._$AR(), this._$AH = A) : t5 !== this._$AH && t5 !== E && this._(t5) : void 0 !== t5._$litType$ ? this.$(t5) : void 0 !== t5.nodeType ? this.T(t5) : d2(t5) ? this.k(t5) : this._(t5);
    }
    O(t5) {
      return this._$AA.parentNode.insertBefore(t5, this._$AB);
    }
    T(t5) {
      this._$AH !== t5 && (this._$AR(), this._$AH = this.O(t5));
    }
    _(t5) {
      this._$AH !== A && a2(this._$AH) ? this._$AA.nextSibling.data = t5 : this.T(l2.createTextNode(t5)), this._$AH = t5;
    }
    $(t5) {
      const { values: i6, _$litType$: s5 } = t5, e6 = "number" == typeof s5 ? this._$AC(t5) : (void 0 === s5.el && (s5.el = S2.createElement(V(s5.h, s5.h[0]), this.options)), s5);
      if (this._$AH?._$AD === e6) this._$AH.p(i6);
      else {
        const t6 = new R(e6, this), s6 = t6.u(this.options);
        t6.p(i6), this.T(s6), this._$AH = t6;
      }
    }
    _$AC(t5) {
      let i6 = C.get(t5.strings);
      return void 0 === i6 && C.set(t5.strings, i6 = new S2(t5)), i6;
    }
    k(t5) {
      u2(this._$AH) || (this._$AH = [], this._$AR());
      const i6 = this._$AH;
      let s5, e6 = 0;
      for (const h4 of t5) e6 === i6.length ? i6.push(s5 = new _k(this.O(c3()), this.O(c3()), this, this.options)) : s5 = i6[e6], s5._$AI(h4), e6++;
      e6 < i6.length && (this._$AR(s5 && s5._$AB.nextSibling, e6), i6.length = e6);
    }
    _$AR(t5 = this._$AA.nextSibling, s5) {
      for (this._$AP?.(false, true, s5); t5 !== this._$AB; ) {
        const s6 = i3(t5).nextSibling;
        i3(t5).remove(), t5 = s6;
      }
    }
    setConnected(t5) {
      void 0 === this._$AM && (this._$Cv = t5, this._$AP?.(t5));
    }
  };
  var H = class {
    get tagName() {
      return this.element.tagName;
    }
    get _$AU() {
      return this._$AM._$AU;
    }
    constructor(t5, i6, s5, e6, h4) {
      this.type = 1, this._$AH = A, this._$AN = void 0, this.element = t5, this.name = i6, this._$AM = e6, this.options = h4, s5.length > 2 || "" !== s5[0] || "" !== s5[1] ? (this._$AH = Array(s5.length - 1).fill(new String()), this.strings = s5) : this._$AH = A;
    }
    _$AI(t5, i6 = this, s5, e6) {
      const h4 = this.strings;
      let o7 = false;
      if (void 0 === h4) t5 = M(this, t5, i6, 0), o7 = !a2(t5) || t5 !== this._$AH && t5 !== E, o7 && (this._$AH = t5);
      else {
        const e7 = t5;
        let n6, r7;
        for (t5 = h4[0], n6 = 0; n6 < h4.length - 1; n6++) r7 = M(this, e7[s5 + n6], i6, n6), r7 === E && (r7 = this._$AH[n6]), o7 ||= !a2(r7) || r7 !== this._$AH[n6], r7 === A ? t5 = A : t5 !== A && (t5 += (r7 ?? "") + h4[n6 + 1]), this._$AH[n6] = r7;
      }
      o7 && !e6 && this.j(t5);
    }
    j(t5) {
      t5 === A ? this.element.removeAttribute(this.name) : this.element.setAttribute(this.name, t5 ?? "");
    }
  };
  var I = class extends H {
    constructor() {
      super(...arguments), this.type = 3;
    }
    j(t5) {
      this.element[this.name] = t5 === A ? void 0 : t5;
    }
  };
  var L = class extends H {
    constructor() {
      super(...arguments), this.type = 4;
    }
    j(t5) {
      this.element.toggleAttribute(this.name, !!t5 && t5 !== A);
    }
  };
  var z = class extends H {
    constructor(t5, i6, s5, e6, h4) {
      super(t5, i6, s5, e6, h4), this.type = 5;
    }
    _$AI(t5, i6 = this) {
      if ((t5 = M(this, t5, i6, 0) ?? A) === E) return;
      const s5 = this._$AH, e6 = t5 === A && s5 !== A || t5.capture !== s5.capture || t5.once !== s5.once || t5.passive !== s5.passive, h4 = t5 !== A && (s5 === A || e6);
      e6 && this.element.removeEventListener(this.name, this, s5), h4 && this.element.addEventListener(this.name, this, t5), this._$AH = t5;
    }
    handleEvent(t5) {
      "function" == typeof this._$AH ? this._$AH.call(this.options?.host ?? this.element, t5) : this._$AH.handleEvent(t5);
    }
  };
  var Z = class {
    constructor(t5, i6, s5) {
      this.element = t5, this.type = 6, this._$AN = void 0, this._$AM = i6, this.options = s5;
    }
    get _$AU() {
      return this._$AM._$AU;
    }
    _$AI(t5) {
      M(this, t5);
    }
  };
  var B = t2.litHtmlPolyfillSupport;
  B?.(S2, k), (t2.litHtmlVersions ??= []).push("3.3.2");

  // ../node_modules/.pnpm/lit-html@3.3.3/node_modules/lit-html/lit-html.js
  var t3 = globalThis;
  var i4 = (t5) => t5;
  var s3 = t3.trustedTypes;
  var e4 = s3 ? s3.createPolicy("lit-html", { createHTML: (t5) => t5 }) : void 0;
  var h3 = "$lit$";
  var o4 = `lit$${Math.random().toFixed(9).slice(2)}$`;
  var n4 = "?" + o4;
  var r4 = `<${n4}>`;
  var l3 = document;
  var c4 = () => l3.createComment("");
  var a3 = (t5) => null === t5 || "object" != typeof t5 && "function" != typeof t5;
  var u3 = Array.isArray;
  var d3 = (t5) => u3(t5) || "function" == typeof t5?.[Symbol.iterator];
  var f3 = "[ 	\n\f\r]";
  var v2 = /<(?:(!--|\/[^a-zA-Z])|(\/?[a-zA-Z][^>\s]*)|(\/?$))/g;
  var _2 = /-->/g;
  var m2 = />/g;
  var p3 = RegExp(`>|${f3}(?:([^\\s"'>=/]+)(${f3}*=${f3}*(?:[^ 	
\f\r"'\`<>=]|("|')|))|$)`, "g");
  var g2 = /'/g;
  var $2 = /"/g;
  var y3 = /^(?:script|style|textarea|title)$/i;
  var x2 = (t5) => (i6, ...s5) => ({ _$litType$: t5, strings: i6, values: s5 });
  var b3 = x2(1);
  var w2 = x2(2);
  var T2 = x2(3);
  var E2 = /* @__PURE__ */ Symbol.for("lit-noChange");
  var A2 = /* @__PURE__ */ Symbol.for("lit-nothing");
  var C2 = /* @__PURE__ */ new WeakMap();
  var P2 = l3.createTreeWalker(l3, 129);
  function V2(t5, i6) {
    if (!u3(t5) || !t5.hasOwnProperty("raw")) throw Error("invalid template strings array");
    return void 0 !== e4 ? e4.createHTML(i6) : i6;
  }
  var N2 = (t5, i6) => {
    const s5 = t5.length - 1, e6 = [];
    let n6, l4 = 2 === i6 ? "<svg>" : 3 === i6 ? "<math>" : "", c5 = v2;
    for (let i7 = 0; i7 < s5; i7++) {
      const s6 = t5[i7];
      let a4, u4, d4 = -1, f4 = 0;
      for (; f4 < s6.length && (c5.lastIndex = f4, u4 = c5.exec(s6), null !== u4); ) f4 = c5.lastIndex, c5 === v2 ? "!--" === u4[1] ? c5 = _2 : void 0 !== u4[1] ? c5 = m2 : void 0 !== u4[2] ? (y3.test(u4[2]) && (n6 = RegExp("</" + u4[2], "g")), c5 = p3) : void 0 !== u4[3] && (c5 = p3) : c5 === p3 ? ">" === u4[0] ? (c5 = n6 ?? v2, d4 = -1) : void 0 === u4[1] ? d4 = -2 : (d4 = c5.lastIndex - u4[2].length, a4 = u4[1], c5 = void 0 === u4[3] ? p3 : '"' === u4[3] ? $2 : g2) : c5 === $2 || c5 === g2 ? c5 = p3 : c5 === _2 || c5 === m2 ? c5 = v2 : (c5 = p3, n6 = void 0);
      const x3 = c5 === p3 && t5[i7 + 1].startsWith("/>") ? " " : "";
      l4 += c5 === v2 ? s6 + r4 : d4 >= 0 ? (e6.push(a4), s6.slice(0, d4) + h3 + s6.slice(d4) + o4 + x3) : s6 + o4 + (-2 === d4 ? i7 : x3);
    }
    return [V2(t5, l4 + (t5[s5] || "<?>") + (2 === i6 ? "</svg>" : 3 === i6 ? "</math>" : "")), e6];
  };
  var S3 = class _S {
    constructor({ strings: t5, _$litType$: i6 }, e6) {
      let r7;
      this.parts = [];
      let l4 = 0, a4 = 0;
      const u4 = t5.length - 1, d4 = this.parts, [f4, v3] = N2(t5, i6);
      if (this.el = _S.createElement(f4, e6), P2.currentNode = this.el.content, 2 === i6 || 3 === i6) {
        const t6 = this.el.content.firstChild;
        t6.replaceWith(...t6.childNodes);
      }
      for (; null !== (r7 = P2.nextNode()) && d4.length < u4; ) {
        if (1 === r7.nodeType) {
          if (r7.hasAttributes()) for (const t6 of r7.getAttributeNames()) if (t6.endsWith(h3)) {
            const i7 = v3[a4++], s5 = r7.getAttribute(t6).split(o4), e7 = /([.?@])?(.*)/.exec(i7);
            d4.push({ type: 1, index: l4, name: e7[2], strings: s5, ctor: "." === e7[1] ? I2 : "?" === e7[1] ? L2 : "@" === e7[1] ? z2 : H2 }), r7.removeAttribute(t6);
          } else t6.startsWith(o4) && (d4.push({ type: 6, index: l4 }), r7.removeAttribute(t6));
          if (y3.test(r7.tagName)) {
            const t6 = r7.textContent.split(o4), i7 = t6.length - 1;
            if (i7 > 0) {
              r7.textContent = s3 ? s3.emptyScript : "";
              for (let s5 = 0; s5 < i7; s5++) r7.append(t6[s5], c4()), P2.nextNode(), d4.push({ type: 2, index: ++l4 });
              r7.append(t6[i7], c4());
            }
          }
        } else if (8 === r7.nodeType) if (r7.data === n4) d4.push({ type: 2, index: l4 });
        else {
          let t6 = -1;
          for (; -1 !== (t6 = r7.data.indexOf(o4, t6 + 1)); ) d4.push({ type: 7, index: l4 }), t6 += o4.length - 1;
        }
        l4++;
      }
    }
    static createElement(t5, i6) {
      const s5 = l3.createElement("template");
      return s5.innerHTML = t5, s5;
    }
  };
  function M2(t5, i6, s5 = t5, e6) {
    if (i6 === E2) return i6;
    let h4 = void 0 !== e6 ? s5._$Co?.[e6] : s5._$Cl;
    const o7 = a3(i6) ? void 0 : i6._$litDirective$;
    return h4?.constructor !== o7 && (h4?._$AO?.(false), void 0 === o7 ? h4 = void 0 : (h4 = new o7(t5), h4._$AT(t5, s5, e6)), void 0 !== e6 ? (s5._$Co ??= [])[e6] = h4 : s5._$Cl = h4), void 0 !== h4 && (i6 = M2(t5, h4._$AS(t5, i6.values), h4, e6)), i6;
  }
  var R2 = class {
    constructor(t5, i6) {
      this._$AV = [], this._$AN = void 0, this._$AD = t5, this._$AM = i6;
    }
    get parentNode() {
      return this._$AM.parentNode;
    }
    get _$AU() {
      return this._$AM._$AU;
    }
    u(t5) {
      const { el: { content: i6 }, parts: s5 } = this._$AD, e6 = (t5?.creationScope ?? l3).importNode(i6, true);
      P2.currentNode = e6;
      let h4 = P2.nextNode(), o7 = 0, n6 = 0, r7 = s5[0];
      for (; void 0 !== r7; ) {
        if (o7 === r7.index) {
          let i7;
          2 === r7.type ? i7 = new k2(h4, h4.nextSibling, this, t5) : 1 === r7.type ? i7 = new r7.ctor(h4, r7.name, r7.strings, this, t5) : 6 === r7.type && (i7 = new Z2(h4, this, t5)), this._$AV.push(i7), r7 = s5[++n6];
        }
        o7 !== r7?.index && (h4 = P2.nextNode(), o7++);
      }
      return P2.currentNode = l3, e6;
    }
    p(t5) {
      let i6 = 0;
      for (const s5 of this._$AV) void 0 !== s5 && (void 0 !== s5.strings ? (s5._$AI(t5, s5, i6), i6 += s5.strings.length - 2) : s5._$AI(t5[i6])), i6++;
    }
  };
  var k2 = class _k {
    get _$AU() {
      return this._$AM?._$AU ?? this._$Cv;
    }
    constructor(t5, i6, s5, e6) {
      this.type = 2, this._$AH = A2, this._$AN = void 0, this._$AA = t5, this._$AB = i6, this._$AM = s5, this.options = e6, this._$Cv = e6?.isConnected ?? true;
    }
    get parentNode() {
      let t5 = this._$AA.parentNode;
      const i6 = this._$AM;
      return void 0 !== i6 && 11 === t5?.nodeType && (t5 = i6.parentNode), t5;
    }
    get startNode() {
      return this._$AA;
    }
    get endNode() {
      return this._$AB;
    }
    _$AI(t5, i6 = this) {
      t5 = M2(this, t5, i6), a3(t5) ? t5 === A2 || null == t5 || "" === t5 ? (this._$AH !== A2 && this._$AR(), this._$AH = A2) : t5 !== this._$AH && t5 !== E2 && this._(t5) : void 0 !== t5._$litType$ ? this.$(t5) : void 0 !== t5.nodeType ? this.T(t5) : d3(t5) ? this.k(t5) : this._(t5);
    }
    O(t5) {
      return this._$AA.parentNode.insertBefore(t5, this._$AB);
    }
    T(t5) {
      this._$AH !== t5 && (this._$AR(), this._$AH = this.O(t5));
    }
    _(t5) {
      this._$AH !== A2 && a3(this._$AH) ? this._$AA.nextSibling.data = t5 : this.T(l3.createTextNode(t5)), this._$AH = t5;
    }
    $(t5) {
      const { values: i6, _$litType$: s5 } = t5, e6 = "number" == typeof s5 ? this._$AC(t5) : (void 0 === s5.el && (s5.el = S3.createElement(V2(s5.h, s5.h[0]), this.options)), s5);
      if (this._$AH?._$AD === e6) this._$AH.p(i6);
      else {
        const t6 = new R2(e6, this), s6 = t6.u(this.options);
        t6.p(i6), this.T(s6), this._$AH = t6;
      }
    }
    _$AC(t5) {
      let i6 = C2.get(t5.strings);
      return void 0 === i6 && C2.set(t5.strings, i6 = new S3(t5)), i6;
    }
    k(t5) {
      u3(this._$AH) || (this._$AH = [], this._$AR());
      const i6 = this._$AH;
      let s5, e6 = 0;
      for (const h4 of t5) e6 === i6.length ? i6.push(s5 = new _k(this.O(c4()), this.O(c4()), this, this.options)) : s5 = i6[e6], s5._$AI(h4), e6++;
      e6 < i6.length && (this._$AR(s5 && s5._$AB.nextSibling, e6), i6.length = e6);
    }
    _$AR(t5 = this._$AA.nextSibling, s5) {
      for (this._$AP?.(false, true, s5); t5 !== this._$AB; ) {
        const s6 = i4(t5).nextSibling;
        i4(t5).remove(), t5 = s6;
      }
    }
    setConnected(t5) {
      void 0 === this._$AM && (this._$Cv = t5, this._$AP?.(t5));
    }
  };
  var H2 = class {
    get tagName() {
      return this.element.tagName;
    }
    get _$AU() {
      return this._$AM._$AU;
    }
    constructor(t5, i6, s5, e6, h4) {
      this.type = 1, this._$AH = A2, this._$AN = void 0, this.element = t5, this.name = i6, this._$AM = e6, this.options = h4, s5.length > 2 || "" !== s5[0] || "" !== s5[1] ? (this._$AH = Array(s5.length - 1).fill(new String()), this.strings = s5) : this._$AH = A2;
    }
    _$AI(t5, i6 = this, s5, e6) {
      const h4 = this.strings;
      let o7 = false;
      if (void 0 === h4) t5 = M2(this, t5, i6, 0), o7 = !a3(t5) || t5 !== this._$AH && t5 !== E2, o7 && (this._$AH = t5);
      else {
        const e7 = t5;
        let n6, r7;
        for (t5 = h4[0], n6 = 0; n6 < h4.length - 1; n6++) r7 = M2(this, e7[s5 + n6], i6, n6), r7 === E2 && (r7 = this._$AH[n6]), o7 ||= !a3(r7) || r7 !== this._$AH[n6], r7 === A2 ? t5 = A2 : t5 !== A2 && (t5 += (r7 ?? "") + h4[n6 + 1]), this._$AH[n6] = r7;
      }
      o7 && !e6 && this.j(t5);
    }
    j(t5) {
      t5 === A2 ? this.element.removeAttribute(this.name) : this.element.setAttribute(this.name, t5 ?? "");
    }
  };
  var I2 = class extends H2 {
    constructor() {
      super(...arguments), this.type = 3;
    }
    j(t5) {
      this.element[this.name] = t5 === A2 ? void 0 : t5;
    }
  };
  var L2 = class extends H2 {
    constructor() {
      super(...arguments), this.type = 4;
    }
    j(t5) {
      this.element.toggleAttribute(this.name, !!t5 && t5 !== A2);
    }
  };
  var z2 = class extends H2 {
    constructor(t5, i6, s5, e6, h4) {
      super(t5, i6, s5, e6, h4), this.type = 5;
    }
    _$AI(t5, i6 = this) {
      if ((t5 = M2(this, t5, i6, 0) ?? A2) === E2) return;
      const s5 = this._$AH, e6 = t5 === A2 && s5 !== A2 || t5.capture !== s5.capture || t5.once !== s5.once || t5.passive !== s5.passive, h4 = t5 !== A2 && (s5 === A2 || e6);
      e6 && this.element.removeEventListener(this.name, this, s5), h4 && this.element.addEventListener(this.name, this, t5), this._$AH = t5;
    }
    handleEvent(t5) {
      "function" == typeof this._$AH ? this._$AH.call(this.options?.host ?? this.element, t5) : this._$AH.handleEvent(t5);
    }
  };
  var Z2 = class {
    constructor(t5, i6, s5) {
      this.element = t5, this.type = 6, this._$AN = void 0, this._$AM = i6, this.options = s5;
    }
    get _$AU() {
      return this._$AM._$AU;
    }
    _$AI(t5) {
      M2(this, t5);
    }
  };
  var B2 = t3.litHtmlPolyfillSupport;
  B2?.(S3, k2), (t3.litHtmlVersions ??= []).push("3.3.3");
  var D = (t5, i6, s5) => {
    const e6 = s5?.renderBefore ?? i6;
    let h4 = e6._$litPart$;
    if (void 0 === h4) {
      const t6 = s5?.renderBefore ?? null;
      e6._$litPart$ = h4 = new k2(i6.insertBefore(c4(), t6), t6, void 0, s5 ?? {});
    }
    return h4._$AI(t5), h4;
  };

  // ../node_modules/.pnpm/lit-element@4.2.2/node_modules/lit-element/lit-element.js
  var s4 = globalThis;
  var i5 = class extends y {
    constructor() {
      super(...arguments), this.renderOptions = { host: this }, this._$Do = void 0;
    }
    createRenderRoot() {
      const t5 = super.createRenderRoot();
      return this.renderOptions.renderBefore ??= t5.firstChild, t5;
    }
    update(t5) {
      const r7 = this.render();
      this.hasUpdated || (this.renderOptions.isConnected = this.isConnected), super.update(t5), this._$Do = D(r7, this.renderRoot, this.renderOptions);
    }
    connectedCallback() {
      super.connectedCallback(), this._$Do?.setConnected(true);
    }
    disconnectedCallback() {
      super.disconnectedCallback(), this._$Do?.setConnected(false);
    }
    render() {
      return E2;
    }
  };
  i5._$litElement$ = true, i5["finalized"] = true, s4.litElementHydrateSupport?.({ LitElement: i5 });
  var o5 = s4.litElementPolyfillSupport;
  o5?.({ LitElement: i5 });
  (s4.litElementVersions ??= []).push("4.2.2");

  // ../node_modules/.pnpm/@lit+reactive-element@2.1.2/node_modules/@lit/reactive-element/decorators/custom-element.js
  var t4 = (t5) => (e6, o7) => {
    void 0 !== o7 ? o7.addInitializer(() => {
      customElements.define(t5, e6);
    }) : customElements.define(t5, e6);
  };

  // ../node_modules/.pnpm/@lit+reactive-element@2.1.2/node_modules/@lit/reactive-element/decorators/property.js
  var o6 = { attribute: true, type: String, converter: u, reflect: false, hasChanged: f };
  var r5 = (t5 = o6, e6, r7) => {
    const { kind: n6, metadata: i6 } = r7;
    let s5 = globalThis.litPropertyMetadata.get(i6);
    if (void 0 === s5 && globalThis.litPropertyMetadata.set(i6, s5 = /* @__PURE__ */ new Map()), "setter" === n6 && ((t5 = Object.create(t5)).wrapped = true), s5.set(r7.name, t5), "accessor" === n6) {
      const { name: o7 } = r7;
      return { set(r8) {
        const n7 = e6.get.call(this);
        e6.set.call(this, r8), this.requestUpdate(o7, n7, t5, true, r8);
      }, init(e7) {
        return void 0 !== e7 && this.C(o7, void 0, t5, e7), e7;
      } };
    }
    if ("setter" === n6) {
      const { name: o7 } = r7;
      return function(r8) {
        const n7 = this[o7];
        e6.call(this, r8), this.requestUpdate(o7, n7, t5, true, r8);
      };
    }
    throw Error("Unsupported decorator location: " + n6);
  };
  function n5(t5) {
    return (e6, o7) => "object" == typeof o7 ? r5(t5, e6, o7) : ((t6, e7, o8) => {
      const r7 = e7.hasOwnProperty(o8);
      return e7.constructor.createProperty(o8, t6), r7 ? Object.getOwnPropertyDescriptor(e7, o8) : void 0;
    })(t5, e6, o7);
  }

  // ../node_modules/.pnpm/@lit+reactive-element@2.1.2/node_modules/@lit/reactive-element/decorators/state.js
  function r6(r7) {
    return n5({ ...r7, state: true, attribute: false });
  }

  // src/ui/components/agent-fx-layer/colors.ts
  var hex = (h4) => ({
    r: parseInt(h4.slice(1, 3), 16),
    g: parseInt(h4.slice(3, 5), 16),
    b: parseInt(h4.slice(5, 7), 16)
  });
  var STATUS_COLORS = {
    running: hex("#d4af37"),
    // gold
    idle: hex("#64748b"),
    // dim slate
    failed: hex("#dc143c"),
    // crimson
    completed: hex("#34d399"),
    // mint
    blocked: hex("#f59e0b")
    // amber
  };
  function statusKey(status) {
    const s5 = (status ?? "").toLowerCase();
    if (s5 === "failed" || s5 === "error" || s5 === "errored") return "failed";
    if (s5 === "blocked" || s5 === "waiting" || s5 === "paused") return "blocked";
    if (s5 === "completed" || s5 === "done" || s5 === "finished" || s5 === "success")
      return "completed";
    if (s5 === "running" || s5 === "working" || s5 === "active" || s5 === "starting" || s5 === "finishing" || s5 === "busy")
      return "running";
    return "idle";
  }
  var BACKEND_COLORS = {
    "claude-code": hex("#d97757"),
    // claude clay
    claude: hex("#d97757"),
    opencode: hex("#2dd4bf"),
    // teal
    codex: hex("#e5e7eb"),
    // openai light
    gemini: hex("#4285f4")
    // google blue
  };
  var DEFAULT_BACKEND = hex("#7dd3fc");

  // src/ui/components/world-timeline-scrubber/frame-store.ts
  var LS_KEY = "infinibot.worldReplay.v1";
  var FrameStore = class {
    constructor(opts = {}) {
      this.frames = [];
      this.events = [];
      this.prevStatus = /* @__PURE__ */ new Map();
      this.saveTimer = 0;
      this.listeners = /* @__PURE__ */ new Set();
      this.windowSeconds = opts.windowSeconds ?? 3600;
      const hz = opts.hz ?? 1;
      this.capacity = Math.max(60, Math.round(this.windowSeconds * hz));
      this.persist = opts.persist ?? true;
      this.persistCap = opts.persistCap ?? 1800;
      if (this.persist) this.load();
    }
    /** Subscribe to mutations (new frame / events). Returns an unsubscribe fn. */
    onChange(fn) {
      this.listeners.add(fn);
      return () => this.listeners.delete(fn);
    }
    emit() {
      for (const l4 of this.listeners) {
        try {
          l4();
        } catch {
        }
      }
    }
    /** Record a snapshot at time `t` (epoch ms) and derive any status events. */
    push(agents, t5) {
      this.frames.push({ t: t5, agents: agents.map((a4) => ({ ...a4 })) });
      const seen = /* @__PURE__ */ new Set();
      for (const a4 of agents) {
        seen.add(a4.id);
        const prev = this.prevStatus.get(a4.id);
        if (prev === void 0) {
          this.events.push({ t: t5, id: a4.id, kind: "spawn", label: a4.id });
        } else {
          const pk = statusKey(prev);
          const k3 = statusKey(a4.status);
          if (k3 !== pk) {
            if (k3 === "completed") this.events.push({ t: t5, id: a4.id, kind: "complete", label: a4.id });
            else if (k3 === "failed") this.events.push({ t: t5, id: a4.id, kind: "fail", label: a4.id });
            else if (k3 === "blocked") this.events.push({ t: t5, id: a4.id, kind: "blocked", label: a4.id });
          }
        }
        this.prevStatus.set(a4.id, a4.status);
      }
      for (const id of [...this.prevStatus.keys()]) if (!seen.has(id)) this.prevStatus.delete(id);
      this.trim(t5);
      this.emit();
      this.scheduleSave();
    }
    /** Bulk-seed frames+events (used by tests / backfill). Recomputes nothing. */
    seed(frames, events) {
      this.frames = frames.slice().sort((a4, b4) => a4.t - b4.t);
      this.events = events.slice().sort((a4, b4) => a4.t - b4.t);
      const last = this.frames[this.frames.length - 1];
      if (last) for (const a4 of last.agents) this.prevStatus.set(a4.id, a4.status);
      this.emit();
    }
    trim(now) {
      const cutoff = now - this.windowSeconds * 1e3;
      while (this.frames.length && this.frames[0].t < cutoff) this.frames.shift();
      while (this.frames.length > this.capacity) this.frames.shift();
      while (this.events.length && this.events[0].t < cutoff) this.events.shift();
    }
    // ── Read API ──────────────────────────────────────────────────────────────
    /** Earliest retained frame time, or `now - window` if empty. */
    start(now) {
      return now - this.windowSeconds * 1e3;
    }
    framesInWindow(now) {
      const cutoff = this.start(now);
      return this.frames.filter((f4) => f4.t >= cutoff);
    }
    eventsInWindow(now) {
      const cutoff = this.start(now);
      return this.events.filter((e6) => e6.t >= cutoff);
    }
    get frameCount() {
      return this.frames.length;
    }
    /** Nearest frame with frame.t <= t (binary search). null if none. */
    frameAt(t5) {
      const f4 = this.frames;
      if (!f4.length) return null;
      if (t5 <= f4[0].t) return f4[0];
      if (t5 >= f4[f4.length - 1].t) return f4[f4.length - 1];
      let lo = 0;
      let hi = f4.length - 1;
      while (lo < hi) {
        const mid = lo + hi + 1 >> 1;
        if (f4[mid].t <= t5) lo = mid;
        else hi = mid - 1;
      }
      return f4[lo];
    }
    // ── Persistence (localStorage spill-over) ──────────────────────────────────
    scheduleSave() {
      if (!this.persist || this.saveTimer) return;
      this.saveTimer = window.setTimeout(() => {
        this.saveTimer = 0;
        this.save();
      }, 5e3);
    }
    save() {
      try {
        const frames = this.frames.slice(-this.persistCap);
        const payload = JSON.stringify({ v: 1, frames, events: this.events.slice(-2e3) });
        localStorage.setItem(LS_KEY, payload);
      } catch {
      }
    }
    load() {
      try {
        const raw = localStorage.getItem(LS_KEY);
        if (!raw) return;
        const data = JSON.parse(raw);
        if (Array.isArray(data.frames)) this.frames = data.frames;
        if (Array.isArray(data.events)) this.events = data.events;
        const last = this.frames[this.frames.length - 1];
        if (last) for (const a4 of last.agents) this.prevStatus.set(a4.id, a4.status);
      } catch {
      }
    }
  };
  var singleton = null;
  function getFrameStore() {
    if (!singleton) singleton = new FrameStore();
    return singleton;
  }

  // src/ui/components/world-timeline-scrubber/replay-collector.ts
  var defaultSource = () => (window.__agentFxState ?? []).map((a4) => ({
    id: a4.id,
    x: a4.x,
    y: a4.y,
    status: a4.status,
    backend: a4.backend
  }));
  var ReplayCollector = class {
    constructor(store = getFrameStore()) {
      this.source = defaultSource;
      this.timer = 0;
      this.refs = 0;
      this.store = store;
    }
    /** Override the agent feed (tests / custom wiring). null restores default. */
    setSource(fn) {
      this.source = fn ?? defaultSource;
    }
    /** Begin/continue collection for one consumer. */
    acquire() {
      this.refs++;
      if (this.refs === 1) this.start();
    }
    /** Release one consumer; stops the loop when the last one leaves. */
    release() {
      this.refs = Math.max(0, this.refs - 1);
      if (this.refs === 0) this.stop();
    }
    start() {
      if (this.timer) return;
      const tick = () => {
        try {
          this.store.push(this.source(), Date.now());
        } catch {
        }
      };
      tick();
      this.timer = window.setInterval(tick, 1e3);
    }
    stop() {
      if (this.timer) {
        clearInterval(this.timer);
        this.timer = 0;
      }
    }
  };
  var singleton2 = null;
  function getReplayCollector() {
    if (!singleton2) singleton2 = new ReplayCollector();
    return singleton2;
  }

  // src/ui/components/world-timeline-scrubber.ts
  var SPEEDS = [0.5, 1, 2, 4];
  var EVENT_COLOR = {
    spawn: "#d4af37",
    // gold
    complete: "#34d399",
    // mint
    fail: "#dc143c",
    // crimson
    blocked: "#f59e0b"
    // amber
  };
  var WorldTimelineScrubber = class extends i5 {
    constructor() {
      super(...arguments);
      this.windowMinutes = 60;
      this.mode = "live";
      this.playing = false;
      this.speed = 1;
      this.currentT = 0;
      this.now = 0;
      this.store = getFrameStore();
      this.collector = getReplayCollector();
      this.unsub = null;
      this.raf = 0;
      this.lastFrameTs = 0;
      this.dragging = false;
      this.lastRenderTs = 0;
      // ── Playback loop ─────────────────────────────────────────────────────────
      this.loop = () => {
        this.raf = requestAnimationFrame(this.loop);
        const ts = performance.now();
        const dtMs = this.lastFrameTs ? ts - this.lastFrameTs : 0;
        this.lastFrameTs = ts;
        this.now = Date.now();
        if (this.mode === "live") {
          this.currentT = this.now;
          if (window.__worldReplayFrame) window.__worldReplayFrame = null;
        } else {
          if (this.playing) {
            this.currentT += dtMs * this.speed;
            if (this.currentT >= this.now) {
              this.setLive();
              return;
            }
          }
          const min = this.store.start(this.now);
          if (this.currentT < min) this.currentT = min;
          this.broadcast();
        }
        if (ts - this.lastRenderTs > 50) {
          this.lastRenderTs = ts;
          this.requestUpdate();
        }
      };
      this.onTrackDown = (e6) => {
        this.dragging = true;
        e6.currentTarget.setPointerCapture(e6.pointerId);
        this.enterReplay(this.ratioToTime(this.ratioFromEvent(e6)));
        this.broadcast();
      };
      this.onTrackMove = (e6) => {
        if (!this.dragging) return;
        this.enterReplay(this.ratioToTime(this.ratioFromEvent(e6)));
        this.broadcast();
      };
      this.onTrackUp = (e6) => {
        this.dragging = false;
        try {
          e6.currentTarget.releasePointerCapture(e6.pointerId);
        } catch {
        }
      };
    }
    // ── Lifecycle ───────────────────────────────────────────────────────────
    connectedCallback() {
      super.connectedCallback();
      this.now = Date.now();
      this.currentT = this.now;
      this.store = getFrameStore();
      this.collector.acquire();
      this.unsub = this.store.onChange(() => this.requestUpdate());
      this.loop();
    }
    disconnectedCallback() {
      super.disconnectedCallback();
      cancelAnimationFrame(this.raf);
      this.collector.release();
      this.unsub?.();
      this.unsub = null;
      if (window.__worldReplayFrame) window.__worldReplayFrame = null;
    }
    get windowMs() {
      return this.windowMinutes * 60 * 1e3;
    }
    broadcast() {
      const frame = this.store.frameAt(this.currentT);
      const detail = { t: this.currentT, agents: frame ? frame.agents : [] };
      window.__worldReplayFrame = detail;
      window.dispatchEvent(new CustomEvent("world-replay-frame", { detail }));
    }
    // ── Mode / control handlers ─────────────────────────────────────────────
    setLive() {
      this.mode = "live";
      this.playing = false;
      this.currentT = this.now = Date.now();
      if (window.__worldReplayFrame) window.__worldReplayFrame = null;
      this.requestUpdate();
    }
    enterReplay(t5) {
      this.mode = "replay";
      this.currentT = t5;
      this.requestUpdate();
    }
    togglePlay() {
      if (this.mode === "live") {
        this.enterReplay(this.store.start(Date.now()));
      }
      this.playing = !this.playing;
    }
    cycleSpeed() {
      const i6 = SPEEDS.indexOf(this.speed);
      this.speed = SPEEDS[(i6 + 1) % SPEEDS.length];
    }
    // ── Track interaction ─────────────────────────────────────────────────────
    ratioToTime(ratio) {
      const r7 = Math.max(0, Math.min(1, ratio));
      return this.store.start(this.now) + r7 * this.windowMs;
    }
    timeToRatio(t5) {
      const r7 = (t5 - this.store.start(this.now)) / this.windowMs;
      return Math.max(0, Math.min(1, r7));
    }
    ratioFromEvent(e6) {
      const track = this.renderRoot.querySelector(".track");
      if (!track) return 0;
      const rect = track.getBoundingClientRect();
      return (e6.clientX - rect.left) / Math.max(1, rect.width);
    }
    // ── Render ──────────────────────────────────────────────────────────────
    fmtClock(t5) {
      const d4 = new Date(t5);
      const p4 = (n6) => String(n6).padStart(2, "0");
      return `${p4(d4.getHours())}:${p4(d4.getMinutes())}:${p4(d4.getSeconds())}`;
    }
    fmtRel() {
      if (this.mode === "live") return "LIVE";
      const back = Math.max(0, Math.round((this.now - this.currentT) / 1e3));
      const m3 = Math.floor(back / 60);
      const s5 = back % 60;
      return m3 > 0 ? `\u2212${m3}m ${s5}s` : `\u2212${s5}s`;
    }
    render() {
      const ratio = this.mode === "live" ? 1 : this.timeToRatio(this.currentT);
      const fillPct = (ratio * 100).toFixed(2);
      const events = this.store.eventsInWindow(this.now);
      const replaying = this.mode === "replay";
      return b3`
      <div class="bar">
        <div class="controls">
          <button
            class="live ${replaying ? "replaying" : ""}"
            title=${replaying ? "Return to live" : "Live \u2014 pinned to now"}
            @click=${() => this.setLive()}
          >
            <span class="dot"></span>${replaying ? "REPLAY" : "LIVE"}
          </button>
          <button class="play" title=${this.playing ? "Pause" : "Play"} @click=${() => this.togglePlay()}>
            ${this.playing ? "\u23F8" : "\u25B6"}
          </button>
          <button title="Playback speed" @click=${() => this.cycleSpeed()}>${this.speed}×</button>
        </div>

        <div
          class="track"
          @pointerdown=${this.onTrackDown}
          @pointermove=${this.onTrackMove}
          @pointerup=${this.onTrackUp}
          @pointercancel=${this.onTrackUp}
        >
          <div class="rail"><div class="fill" style="width:${fillPct}%"></div></div>
          ${events.map((ev) => {
        const left = (this.timeToRatio(ev.t) * 100).toFixed(3);
        return b3`<span
              class="marker"
              title=${`${ev.kind} \xB7 ${ev.label ?? ev.id} \xB7 ${this.fmtClock(ev.t)}`}
              style=${`left:${left}%;background:${EVENT_COLOR[ev.kind]};color:${EVENT_COLOR[ev.kind]}`}
            ></span>`;
      })}
          <div class="handle" style="left:${fillPct}%"></div>
        </div>

        <div class="readout">
          <div class="rel">${this.fmtRel()}</div>
          <div class="abs">${this.fmtClock(this.mode === "live" ? this.now : this.currentT)}</div>
        </div>
      </div>
    `;
    }
  };
  WorldTimelineScrubber.styles = i`
    :host {
      position: absolute;
      left: 0;
      right: 0;
      bottom: 0;
      height: 60px;
      z-index: 20;
      display: block;
      pointer-events: auto;
      font-family: var(--font-mono, ui-monospace, "SF Mono", monospace);
      color: #e8e0c8;
      user-select: none;
    }
    .bar {
      height: 100%;
      display: flex;
      align-items: center;
      gap: 14px;
      padding: 0 16px;
      box-sizing: border-box;
      background: linear-gradient(180deg, rgba(8, 4, 1, 0.72), rgba(4, 2, 0, 0.92));
      backdrop-filter: blur(14px) saturate(1.2);
      -webkit-backdrop-filter: blur(14px) saturate(1.2);
      border-top: 1px solid rgba(212, 175, 55, 0.4);
      box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.05), 0 -10px 30px -16px rgba(0, 0, 0, 0.9);
    }
    .controls {
      display: flex;
      align-items: center;
      gap: 6px;
      flex: 0 0 auto;
    }
    button {
      font: inherit;
      font-size: 11px;
      letter-spacing: 0.04em;
      color: #e8e0c8;
      background: rgba(212, 175, 55, 0.08);
      border: 1px solid rgba(212, 175, 55, 0.28);
      border-radius: 6px;
      padding: 5px 9px;
      cursor: pointer;
      transition: background 0.12s ease, border-color 0.12s ease, color 0.12s ease;
      min-width: 30px;
    }
    button:hover {
      background: rgba(212, 175, 55, 0.18);
      border-color: rgba(212, 175, 55, 0.5);
    }
    button.active {
      background: rgba(212, 175, 55, 0.85);
      border-color: #d4af37;
      color: #1a1200;
      font-weight: 700;
    }
    button.live {
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .dot {
      width: 7px;
      height: 7px;
      border-radius: 50%;
      background: #34d399;
      box-shadow: 0 0 6px #34d399;
    }
    button.live.replaying .dot {
      background: #f59e0b;
      box-shadow: 0 0 6px #f59e0b;
      animation: none;
    }
    button.live:not(.replaying) .dot {
      animation: pulse 1.4s ease-in-out infinite;
    }
    @keyframes pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.35; }
    }
    .play {
      font-size: 13px;
      min-width: 34px;
    }
    /* ── Track ── */
    .track {
      position: relative;
      flex: 1 1 auto;
      height: 30px;
      cursor: pointer;
      display: flex;
      align-items: center;
    }
    .rail {
      position: absolute;
      left: 0;
      right: 0;
      top: 50%;
      transform: translateY(-50%);
      height: 6px;
      border-radius: 3px;
      background: rgba(212, 175, 55, 0.12);
      border: 1px solid rgba(212, 175, 55, 0.2);
      overflow: hidden;
    }
    .fill {
      position: absolute;
      left: 0;
      top: 0;
      bottom: 0;
      background: linear-gradient(90deg, rgba(212, 175, 55, 0.15), rgba(212, 175, 55, 0.5));
    }
    .marker {
      position: absolute;
      top: 50%;
      width: 6px;
      height: 6px;
      margin-left: -3px;
      border-radius: 50%;
      transform: translateY(-50%);
      pointer-events: none;
      box-shadow: 0 0 5px currentColor;
    }
    .handle {
      position: absolute;
      top: 50%;
      width: 3px;
      height: 26px;
      margin-left: -1.5px;
      transform: translateY(-50%);
      background: #f4e4b8;
      border-radius: 2px;
      box-shadow: 0 0 8px rgba(244, 228, 184, 0.9), 0 0 2px #000;
      pointer-events: none;
    }
    .handle::after {
      content: "";
      position: absolute;
      top: -5px;
      left: 50%;
      transform: translateX(-50%);
      border-left: 5px solid transparent;
      border-right: 5px solid transparent;
      border-top: 6px solid #f4e4b8;
    }
    /* ── Readout ── */
    .readout {
      flex: 0 0 auto;
      text-align: right;
      line-height: 1.25;
      min-width: 116px;
    }
    .readout .rel {
      font-size: 12px;
      font-weight: 700;
      color: #f4e4b8;
    }
    .readout .abs {
      font-size: 10px;
      color: rgba(232, 224, 200, 0.6);
      letter-spacing: 0.03em;
    }
    @media (prefers-reduced-motion: reduce) {
      button.live:not(.replaying) .dot { animation: none; }
    }
  `;
  __decorateClass([
    n5({ type: Number, attribute: "window-minutes" })
  ], WorldTimelineScrubber.prototype, "windowMinutes", 2);
  __decorateClass([
    r6()
  ], WorldTimelineScrubber.prototype, "mode", 2);
  __decorateClass([
    r6()
  ], WorldTimelineScrubber.prototype, "playing", 2);
  __decorateClass([
    r6()
  ], WorldTimelineScrubber.prototype, "speed", 2);
  __decorateClass([
    r6()
  ], WorldTimelineScrubber.prototype, "currentT", 2);
  __decorateClass([
    r6()
  ], WorldTimelineScrubber.prototype, "now", 2);
  WorldTimelineScrubber = __decorateClass([
    t4("world-timeline-scrubber")
  ], WorldTimelineScrubber);

  // __test-scrubber.ts
  var W = 900;
  var H3 = 420;
  var BACKENDS = ["claude-code", "opencode", "codex", "gemini"];
  function seed() {
    const now = Date.now();
    const start = now - 60 * 60 * 1e3;
    const frames = [];
    const events = [];
    const agents = Array.from({ length: 6 }, (_3, i6) => {
      const spawnAt = start + i6 * 7 * 60 * 1e3;
      const lifespan = (25 + i6 * 4) * 60 * 1e3;
      const endKind = ["complete", "fail", "blocked", "complete", "blocked", "fail"][i6];
      return { id: `agent-${i6 + 1}`, backend: BACKENDS[i6 % BACKENDS.length], spawnAt, endAt: spawnAt + lifespan, endKind };
    });
    for (let t5 = start; t5 <= now; t5 += 10 * 1e3) {
      const live = agents.filter((a4) => t5 >= a4.spawnAt && t5 <= a4.endAt);
      frames.push({
        t: t5,
        agents: live.map((a4, idx) => {
          const phase = (t5 - a4.spawnAt) / 9e4 + idx;
          let status = "running";
          if (t5 > a4.endAt - 6e4) status = a4.endKind === "complete" ? "completed" : a4.endKind === "fail" ? "failed" : "blocked";
          return {
            id: a4.id,
            x: W * (0.2 + 0.6 * (0.5 + 0.4 * Math.sin(phase))),
            y: H3 * (0.25 + 0.5 * (0.5 + 0.4 * Math.cos(phase * 1.3))),
            status,
            backend: a4.backend
          };
        })
      });
    }
    for (const a4 of agents) {
      events.push({ t: a4.spawnAt, id: a4.id, kind: "spawn", label: a4.id });
      events.push({ t: a4.endAt - 3e4, id: a4.id, kind: a4.endKind, label: a4.id });
    }
    getFrameStore().seed(frames, events);
    window.__agentFxState = frames[frames.length - 1]?.agents ?? [];
  }
  seed();
  var scrubber = document.querySelector("world-timeline-scrubber");
  window.__scrubberTest = {
    setReplay(ratio, playing, speed) {
      const track = scrubber.renderRoot.querySelector(".track");
      const rect = track.getBoundingClientRect();
      const x3 = rect.left + rect.width * ratio;
      track.dispatchEvent(new PointerEvent("pointerdown", { clientX: x3, bubbles: true, pointerId: 1 }));
      track.dispatchEvent(new PointerEvent("pointerup", { clientX: x3, bubbles: true, pointerId: 1 }));
      const sb = scrubber;
      sb.speed = speed;
      sb.playing = playing;
      sb.requestUpdate();
    },
    setLive() {
      scrubber.setLive();
    }
  };
})();
/*! Bundled license information:

@lit/reactive-element/css-tag.js:
  (**
   * @license
   * Copyright 2019 Google LLC
   * SPDX-License-Identifier: BSD-3-Clause
   *)

@lit/reactive-element/reactive-element.js:
lit-html/lit-html.js:
lit-html/lit-html.js:
lit-element/lit-element.js:
@lit/reactive-element/decorators/custom-element.js:
@lit/reactive-element/decorators/property.js:
@lit/reactive-element/decorators/state.js:
@lit/reactive-element/decorators/event-options.js:
@lit/reactive-element/decorators/base.js:
@lit/reactive-element/decorators/query.js:
@lit/reactive-element/decorators/query-all.js:
@lit/reactive-element/decorators/query-async.js:
@lit/reactive-element/decorators/query-assigned-nodes.js:
  (**
   * @license
   * Copyright 2017 Google LLC
   * SPDX-License-Identifier: BSD-3-Clause
   *)

lit-html/is-server.js:
  (**
   * @license
   * Copyright 2022 Google LLC
   * SPDX-License-Identifier: BSD-3-Clause
   *)

@lit/reactive-element/decorators/query-assigned-elements.js:
  (**
   * @license
   * Copyright 2021 Google LLC
   * SPDX-License-Identifier: BSD-3-Clause
   *)
*/
