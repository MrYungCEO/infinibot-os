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

  // src/ui/components/world-overlays/mission-overlay.ts
  var GOLD = "212, 175, 55";
  var MissionRenderer = class {
    draw(ctx, agents, data, now) {
      if (!data) return;
      const pulse = 0.5 + 0.5 * Math.sin(now * 2.2);
      const critical = new Set(data.criticalAgentIds);
      for (const s5 of data.criticalSectors) {
        this.drawSectorHalo(ctx, s5, pulse);
      }
      for (const a4 of agents) {
        if (!critical.has(a4.id)) continue;
        this.drawAgentRing(ctx, a4, pulse);
      }
    }
    drawSectorHalo(ctx, s5, pulse) {
      const r7 = s5.r * (1 + 0.08 * pulse);
      ctx.save();
      const grad = ctx.createRadialGradient(s5.x, s5.y, r7 * 0.4, s5.x, s5.y, r7);
      grad.addColorStop(0, `rgba(${GOLD}, ${0.18 + 0.12 * pulse})`);
      grad.addColorStop(1, `rgba(${GOLD}, 0)`);
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(s5.x, s5.y, r7, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = `rgba(${GOLD}, ${0.5 + 0.3 * pulse})`;
      ctx.lineWidth = 2;
      ctx.setLineDash([6, 5]);
      ctx.lineDashOffset = -pulse * 11;
      ctx.beginPath();
      ctx.arc(s5.x, s5.y, s5.r, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
      this.tag(ctx, s5.x, s5.y - s5.r - 8, s5.label.toUpperCase(), pulse);
    }
    drawAgentRing(ctx, a4, pulse) {
      const base = 22;
      const r7 = base + 4 * pulse;
      ctx.save();
      const grad = ctx.createRadialGradient(a4.x, a4.y, r7 * 0.5, a4.x, a4.y, r7 * 1.8);
      grad.addColorStop(0, `rgba(${GOLD}, ${0.35 + 0.2 * pulse})`);
      grad.addColorStop(1, `rgba(${GOLD}, 0)`);
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(a4.x, a4.y, r7 * 1.8, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = `rgba(${GOLD}, ${0.85})`;
      ctx.lineWidth = 2.5;
      ctx.shadowColor = `rgba(${GOLD}, 0.9)`;
      ctx.shadowBlur = 12;
      ctx.beginPath();
      ctx.arc(a4.x, a4.y, r7, 0, Math.PI * 2);
      ctx.stroke();
      ctx.shadowBlur = 0;
      ctx.strokeStyle = `rgba(${GOLD}, ${0.5})`;
      ctx.lineWidth = 1.5;
      ctx.setLineDash([4, 8]);
      ctx.lineDashOffset = now2(pulse);
      ctx.beginPath();
      ctx.arc(a4.x, a4.y, r7 + 6, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
      this.tag(ctx, a4.x, a4.y - r7 - 14, "\u2605 CRITICAL", pulse);
    }
    tag(ctx, cx, cy, text, pulse) {
      ctx.save();
      ctx.font = "700 11px ui-monospace, monospace";
      const w3 = ctx.measureText(text).width + 14;
      const h4 = 18;
      const x3 = cx - w3 / 2;
      const y4 = cy - h4 / 2;
      ctx.fillStyle = "rgba(10, 12, 20, 0.82)";
      roundRect(ctx, x3, y4, w3, h4, 5);
      ctx.fill();
      ctx.strokeStyle = `rgba(${GOLD}, ${0.6 + 0.3 * pulse})`;
      ctx.lineWidth = 1;
      roundRect(ctx, x3, y4, w3, h4, 5);
      ctx.stroke();
      ctx.fillStyle = `rgba(${GOLD}, 1)`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(text, cx, cy + 0.5);
      ctx.restore();
    }
  };
  function now2(pulse) {
    return -pulse * 12;
  }
  function roundRect(ctx, x3, y4, w3, h4, r7) {
    ctx.beginPath();
    ctx.moveTo(x3 + r7, y4);
    ctx.arcTo(x3 + w3, y4, x3 + w3, y4 + h4, r7);
    ctx.arcTo(x3 + w3, y4 + h4, x3, y4 + h4, r7);
    ctx.arcTo(x3, y4 + h4, x3, y4, r7);
    ctx.arcTo(x3, y4, x3 + w3, y4, r7);
    ctx.closePath();
  }

  // src/ui/components/world-overlays/heatmap-layer.ts
  var HeatmapRenderer = class _HeatmapRenderer {
    /** Color ramp: 0 = gold, 0.5 = amber, 1 = crimson. */
    static ramp(t5) {
      const c5 = clamp01(t5);
      const gold = [212, 175, 55];
      const amber = [255, 158, 44];
      const crimson = [220, 38, 38];
      return c5 < 0.5 ? lerp3(gold, amber, c5 / 0.5) : lerp3(amber, crimson, (c5 - 0.5) / 0.5);
    }
    points(agents, mode, weights2) {
      const raw = [];
      for (const a4 of agents) {
        let v3 = 0;
        if (mode === "credit_burn") v3 = weights2.burn?.[a4.id] ?? 0;
        else if (mode === "failure_rate") v3 = weights2.failure?.[a4.id] ?? 0;
        else {
          const s5 = (a4.status ?? "").toLowerCase();
          v3 = s5 === "active" || s5 === "working" || s5 === "running" || s5 === "busy" ? 1 : 0.25;
        }
        if (v3 > 0) raw.push({ x: a4.x, y: a4.y, v: v3 });
      }
      if (!raw.length) return [];
      const max = Math.max(...raw.map((p4) => p4.v));
      return raw.map((p4) => ({ x: p4.x, y: p4.y, t: max > 0 ? p4.v / max : 0 }));
    }
    draw(ctx, agents, mode, weights2, now, width, height) {
      if (!mode) return;
      const pts = this.points(agents, mode, weights2);
      if (!pts.length) return;
      const pulse = 0.92 + 0.08 * Math.sin(now * 1.3);
      ctx.save();
      ctx.globalCompositeOperation = "lighter";
      const supportsFilter = "filter" in ctx;
      if (supportsFilter) ctx.filter = "blur(26px)";
      for (const p4 of pts) {
        const [r7, g3, b4] = _HeatmapRenderer.ramp(p4.t);
        const radius = (70 + 90 * p4.t) * pulse;
        const alpha = 0.1 + 0.5 * p4.t;
        const grad = ctx.createRadialGradient(p4.x, p4.y, 0, p4.x, p4.y, radius);
        grad.addColorStop(0, `rgba(${r7}, ${g3}, ${b4}, ${alpha})`);
        grad.addColorStop(0.6, `rgba(${r7}, ${g3}, ${b4}, ${alpha * 0.45})`);
        grad.addColorStop(1, `rgba(${r7}, ${g3}, ${b4}, 0)`);
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.arc(p4.x, p4.y, radius, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
      void width;
      void height;
    }
  };
  function clamp01(v3) {
    return v3 < 0 ? 0 : v3 > 1 ? 1 : v3;
  }
  function lerp3(a4, b4, t5) {
    return [
      Math.round(a4[0] + (b4[0] - a4[0]) * t5),
      Math.round(a4[1] + (b4[1] - a4[1]) * t5),
      Math.round(a4[2] + (b4[2] - a4[2]) * t5)
    ];
  }

  // src/ui/components/world-overlays/achievements.ts
  var TIER_COLORS = {
    bronze: "#cd7f32",
    silver: "#c0c6d4",
    gold: "#d4af37",
    legendary: "#b06bff"
  };
  var UI_ACHIEVEMENT_CATALOGUE = [
    { kind: "clean_shipment", label: "Clean Shipment", description: "Shipped a task with zero failed sub-agent runs.", icon: "\u{1F4E6}", tier: "bronze" },
    { kind: "ten_shipments", label: "Ten Down", description: "Completed 10 shipments.", icon: "\u{1F51F}", tier: "silver" },
    { kind: "ship_streak_7day", label: "Seven-Day Streak", description: "Shipped clean work seven days in a row.", icon: "\u{1F525}", tier: "gold" },
    { kind: "federation_milestone", label: "Federation Online", description: "Grew the federation mesh to a new node milestone.", icon: "\u{1F6F0}\uFE0F", tier: "gold" },
    { kind: "focus_session_2h", label: "In The Zone", description: "Held a focus session for two unbroken hours.", icon: "\u{1F3AF}", tier: "silver" },
    { kind: "marathon_focus_4h", label: "Marathon Mind", description: "Sustained a four-hour focus session.", icon: "\u{1F3C3}", tier: "gold" },
    { kind: "hourly_insight_acted", label: "Coachable", description: "Acted on a proactive hourly insight.", icon: "\u{1F4A1}", tier: "bronze" },
    { kind: "zero_failed_day", label: "Flawless Day", description: "Closed a full day with zero failed runs.", icon: "\u2728", tier: "gold" },
    { kind: "first_drag_assign", label: "Hands On", description: "Assigned a task by drag-and-drop for the first time.", icon: "\u{1F590}\uFE0F", tier: "bronze" },
    { kind: "director_mode_first", label: "Take The Chair", description: "Entered Director Mode for the first time.", icon: "\u{1F3AC}", tier: "silver" },
    { kind: "first_voice_command", label: "Speak & Ship", description: "Issued your first voice command to the fleet.", icon: "\u{1F399}\uFE0F", tier: "bronze" },
    { kind: "night_owl", label: "Night Owl", description: "Shipped clean work between midnight and 5am.", icon: "\u{1F989}", tier: "legendary" }
  ];
  function createBadgePopup(ach, onClick) {
    const tier = TIER_COLORS[ach.tier] ?? TIER_COLORS.gold;
    const el = document.createElement("div");
    el.className = "wo-badge-pop";
    el.style.cssText = [
      "pointer-events:auto",
      "display:flex",
      "align-items:center",
      "gap:10px",
      "padding:10px 14px 10px 10px",
      "border-radius:12px",
      "background:linear-gradient(135deg, rgba(16,18,28,.96), rgba(24,20,12,.96))",
      `border:1px solid ${tier}`,
      `box-shadow:0 8px 30px rgba(0,0,0,.5), 0 0 24px ${hexA(tier, 0.45)}`,
      "color:#fff",
      "font:13px/1.3 ui-sans-serif, system-ui, sans-serif",
      "cursor:pointer",
      "transform:translateX(120%)",
      "transition:transform .45s cubic-bezier(.2,.8,.2,1), opacity .4s",
      "max-width:300px"
    ].join(";");
    el.innerHTML = `
    <div style="width:40px;height:40px;border-radius:10px;display:grid;place-items:center;
      font-size:22px;background:${hexA(tier, 0.16)};border:1px solid ${hexA(tier, 0.5)};flex:0 0 auto">
      ${ach.icon}
    </div>
    <div style="min-width:0">
      <div style="font-size:10px;letter-spacing:.12em;text-transform:uppercase;color:${tier};font-weight:700">
        Achievement Unlocked
      </div>
      <div style="font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${ach.label}</div>
      <div style="opacity:.7;font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${ach.description}</div>
    </div>`;
    el.addEventListener("click", onClick);
    requestAnimationFrame(() => {
      el.style.transform = "translateX(0)";
    });
    setTimeout(() => {
      el.style.transform = "translateX(120%)";
      el.style.opacity = "0";
      setTimeout(() => el.remove(), 500);
    }, 5200);
    return el;
  }
  function hexA(hex, a4) {
    const h4 = hex.replace("#", "");
    const r7 = parseInt(h4.slice(0, 2), 16);
    const g3 = parseInt(h4.slice(2, 4), 16);
    const b4 = parseInt(h4.slice(4, 6), 16);
    return `rgba(${r7}, ${g3}, ${b4}, ${a4})`;
  }
  var AchievementsModal = class extends i5 {
    constructor() {
      super(...arguments);
      this.earned = [];
    }
    setAchievements(list) {
      this.earned = [...list];
    }
    open() {
      this.setAttribute("open", "");
    }
    close() {
      this.removeAttribute("open");
    }
    render() {
      const earnedByKind = new Map(this.earned.map((a4) => [a4.kind, a4]));
      const count = this.earned.length;
      const total = UI_ACHIEVEMENT_CATALOGUE.length;
      return b3`
      <div class="scrim" @click=${() => this.close()}></div>
      <div class="panel">
        <header>
          <h2>🏆 Achievements</h2>
          <button class="close" @click=${() => this.close()}>✕</button>
        </header>
        <div class="sub">${count} of ${total} unlocked</div>
        <div class="grid">
          ${UI_ACHIEVEMENT_CATALOGUE.map((def) => {
        const got = earnedByKind.get(def.kind);
        const color = TIER_COLORS[def.tier];
        return b3`
              <div class="card ${got ? "" : "locked"}">
                <div
                  class="ic"
                  style="background:${hexA(color, 0.16)};border:1px solid ${hexA(color, 0.5)}"
                >
                  ${got ? def.icon : "\u{1F512}"}
                </div>
                <div>
                  <div class="ttl" style="color:${got ? color : "#cbd0dd"}">${def.label}</div>
                  <div class="desc">${def.description}</div>
                  ${got ? b3`<div class="when">Earned ${formatWhen(got.earnedAt)}</div>` : A2}
                </div>
              </div>
            `;
      })}
        </div>
      </div>
    `;
    }
  };
  AchievementsModal.styles = i`
    :host {
      position: fixed;
      inset: 0;
      z-index: 60;
      display: none;
      align-items: center;
      justify-content: center;
      pointer-events: auto;
    }
    :host([open]) {
      display: flex;
    }
    .scrim {
      position: absolute;
      inset: 0;
      background: rgba(4, 6, 12, 0.72);
      backdrop-filter: blur(6px);
    }
    .panel {
      position: relative;
      width: min(720px, 92vw);
      max-height: 82vh;
      overflow: auto;
      border-radius: 18px;
      background: linear-gradient(160deg, rgba(18, 20, 30, 0.98), rgba(12, 13, 20, 0.98));
      border: 1px solid rgba(212, 175, 55, 0.35);
      box-shadow: 0 30px 90px rgba(0, 0, 0, 0.6);
      padding: 22px 24px 26px;
      color: #f4f5fa;
      font: 14px/1.4 ui-sans-serif, system-ui, sans-serif;
    }
    header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 4px;
    }
    h2 {
      margin: 0;
      font-size: 18px;
      letter-spacing: 0.02em;
    }
    .sub {
      opacity: 0.6;
      font-size: 12px;
      margin-bottom: 16px;
    }
    .close {
      background: rgba(255, 255, 255, 0.06);
      border: 1px solid rgba(255, 255, 255, 0.12);
      color: #fff;
      width: 30px;
      height: 30px;
      border-radius: 8px;
      cursor: pointer;
      font-size: 16px;
    }
    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
      gap: 12px;
    }
    .card {
      display: flex;
      gap: 10px;
      padding: 12px;
      border-radius: 12px;
      background: rgba(255, 255, 255, 0.03);
      border: 1px solid rgba(255, 255, 255, 0.08);
    }
    .card.locked {
      opacity: 0.42;
      filter: grayscale(0.8);
    }
    .ic {
      width: 42px;
      height: 42px;
      flex: 0 0 auto;
      border-radius: 10px;
      display: grid;
      place-items: center;
      font-size: 22px;
    }
    .ttl {
      font-weight: 700;
      font-size: 13px;
    }
    .desc {
      opacity: 0.65;
      font-size: 11px;
      margin-top: 2px;
    }
    .when {
      font-size: 10px;
      opacity: 0.5;
      margin-top: 4px;
    }
  `;
  __decorateClass([
    r6()
  ], AchievementsModal.prototype, "earned", 2);
  AchievementsModal = __decorateClass([
    t4("achievements-modal")
  ], AchievementsModal);
  function formatWhen(ts) {
    try {
      return new Date(ts).toLocaleString(void 0, {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit"
      });
    } catch {
      return "";
    }
  }

  // src/ui/components/world-overlays/world-overlays.ts
  var HEATMAP_MODES = [
    { mode: "credit_burn", label: "Burn", icon: "\u{1F4B0}" },
    { mode: "activity_density", label: "Activity", icon: "\u26A1" },
    { mode: "failure_rate", label: "Failures", icon: "\u26A0\uFE0F" }
  ];
  var WorldOverlays = class extends i5 {
    constructor() {
      super(...arguments);
      this.heatmapMode = null;
      this.missionEnabled = false;
      this.missionData = null;
      this.heatmapWeights = {};
      this.mission = new MissionRenderer();
      this.heatmap = new HeatmapRenderer();
      this.raf = 0;
      this.dpr = 1;
      this.loop = () => {
        this.raf = requestAnimationFrame(this.loop);
        const ctx = this.ctx;
        if (!ctx || !this.canvas) return;
        const now = performance.now() / 1e3;
        const w3 = this.canvas.width / this.dpr;
        const h4 = this.canvas.height / this.dpr;
        ctx.clearRect(0, 0, w3, h4);
        const agents = this.agents();
        const mode = this.heatmapMode;
        const weights2 = Object.keys(this.heatmapWeights).length ? this.heatmapWeights : window.__worldHeatmap ?? {};
        this.heatmap.draw(ctx, agents, mode, weights2, now, w3, h4);
        if (this.missionEnabled) {
          const data = this.missionData ?? window.__worldMission ?? null;
          this.mission.draw(ctx, agents, data, now);
        }
      };
    }
    render() {
      return b3`
      <canvas></canvas>
      <div class="picker" role="group" aria-label="Heatmap mode">
        <button
          class=${this.heatmapMode === null ? "active" : ""}
          @click=${() => this.setHeatmapMode(null)}
          title="Heatmap off"
        >
          ◯ Off
        </button>
        <span class="sep"></span>
        ${HEATMAP_MODES.map(
        (m3) => b3`
            <button
              class=${this.heatmapMode === m3.mode ? "active" : ""}
              @click=${() => this.setHeatmapMode(m3.mode)}
              title=${m3.label}
            >
              ${m3.icon} ${m3.label}
            </button>
          `
      )}
      </div>
      <div class="trophy" title="Achievements" @click=${() => this.openAchievements()}>🏆</div>
    `;
    }
    firstUpdated() {
      this.canvas = this.renderRoot.querySelector("canvas");
      this.ctx = this.canvas.getContext("2d");
      this.ro = new ResizeObserver(() => this.resize());
      this.ro.observe(this);
      this.resize();
      this.popupHost = document.createElement("div");
      this.popupHost.style.cssText = "position:fixed;top:14px;right:14px;z-index:65;display:flex;flex-direction:column;gap:10px;pointer-events:none";
      document.body.appendChild(this.popupHost);
      this.modal = document.createElement("achievements-modal");
      document.body.appendChild(this.modal);
      if (this.pendingAchievements) this.modal.setAchievements(this.pendingAchievements);
      this.loop();
    }
    disconnectedCallback() {
      super.disconnectedCallback();
      cancelAnimationFrame(this.raf);
      this.ro?.disconnect();
      this.popupHost?.remove();
      this.modal?.remove();
    }
    // ── Public API ──────────────────────────────────────────────────────────
    /** Enable/disable the mission overlay; optionally scope to a project. */
    setMissionEnabled(on, projectId) {
      this.missionEnabled = on;
      if (projectId && this.missionData) this.missionData = { ...this.missionData, projectId };
    }
    setMissionData(data) {
      this.missionData = data;
    }
    setHeatmapMode(mode) {
      this.heatmapMode = mode;
    }
    setHeatmapWeights(weights2) {
      this.heatmapWeights = weights2;
    }
    /** Feed the modal's earned list. */
    setAchievements(list) {
      this.pendingAchievements = list;
      this.modal?.setAchievements(list);
    }
    /** Pop a top-right badge toast for a freshly unlocked achievement. */
    pushAchievement(ach) {
      if (!this.popupHost) return;
      const node = createBadgePopup(ach, () => this.openAchievements());
      this.popupHost.appendChild(node);
    }
    openAchievements() {
      this.modal?.open();
    }
    // ── Internals ───────────────────────────────────────────────────────────
    resize() {
      if (!this.canvas || !this.ctx) return;
      this.dpr = Math.min(window.devicePixelRatio || 1, 2);
      const w3 = this.clientWidth || 1;
      const h4 = this.clientHeight || 1;
      this.canvas.width = Math.round(w3 * this.dpr);
      this.canvas.height = Math.round(h4 * this.dpr);
      this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    }
    agents() {
      return window.__agentFxState ?? [];
    }
  };
  WorldOverlays.styles = i`
    :host {
      position: absolute;
      inset: 0;
      pointer-events: none;
      z-index: 3; /* above <agent-fx-layer> (z=2), below interactive HUD chrome */
    }
    canvas {
      position: absolute;
      inset: 0;
      width: 100%;
      height: 100%;
      display: block;
    }
    .picker {
      position: absolute;
      left: 14px;
      bottom: 14px;
      display: flex;
      gap: 4px;
      padding: 4px;
      border-radius: 12px;
      background: rgba(10, 12, 20, 0.72);
      border: 1px solid rgba(212, 175, 55, 0.28);
      backdrop-filter: blur(8px);
      pointer-events: auto;
      font: 11px/1 ui-sans-serif, system-ui, sans-serif;
    }
    .picker button {
      display: flex;
      align-items: center;
      gap: 5px;
      padding: 6px 9px;
      border-radius: 8px;
      border: 1px solid transparent;
      background: transparent;
      color: #c9cfdd;
      cursor: pointer;
      font: inherit;
      font-weight: 600;
      letter-spacing: 0.02em;
    }
    .picker button:hover {
      background: rgba(255, 255, 255, 0.06);
    }
    .picker button.active {
      color: #1a1205;
      background: linear-gradient(135deg, #e7c64b, #d4af37);
      border-color: rgba(255, 255, 255, 0.25);
    }
    .picker .sep {
      width: 1px;
      align-self: stretch;
      background: rgba(255, 255, 255, 0.1);
      margin: 2px 2px;
    }
    .trophy {
      position: absolute;
      right: 14px;
      bottom: 14px;
      width: 38px;
      height: 38px;
      border-radius: 10px;
      display: grid;
      place-items: center;
      font-size: 18px;
      background: rgba(10, 12, 20, 0.72);
      border: 1px solid rgba(212, 175, 55, 0.28);
      backdrop-filter: blur(8px);
      pointer-events: auto;
      cursor: pointer;
    }
    .trophy:hover {
      border-color: rgba(212, 175, 55, 0.6);
    }
  `;
  __decorateClass([
    r6()
  ], WorldOverlays.prototype, "heatmapMode", 2);
  __decorateClass([
    r6()
  ], WorldOverlays.prototype, "missionEnabled", 2);
  WorldOverlays = __decorateClass([
    t4("world-overlays")
  ], WorldOverlays);

  // src/ui/components/world-overlays/__test.entry.ts
  var stage = document.getElementById("stage");
  var floor = document.createElement("div");
  floor.setAttribute(
    "style",
    "position:absolute;inset:0;z-index:0;background:radial-gradient(60% 50% at 50% 52%, #16203a 0%, #0a0e1a 70%, #06080f 100%)"
  );
  stage.appendChild(floor);
  var sectors = [
    { x: 0.28, y: 0.36, label: "Auth" },
    { x: 0.7, y: 0.34, label: "Billing" },
    { x: 0.5, y: 0.64, label: "Core" },
    { x: 0.8, y: 0.7, label: "Voice" }
  ];
  for (const s5 of sectors) {
    const b4 = document.createElement("div");
    b4.setAttribute(
      "style",
      `position:absolute;left:${s5.x * 100}%;top:${s5.y * 100}%;transform:translate(-50%,-50%);width:54px;height:40px;border-radius:7px;background:rgba(40,52,84,.55);border:1px solid rgba(120,150,210,.4);z-index:0`
    );
    floor.appendChild(b4);
  }
  var wo = document.createElement("world-overlays");
  wo.setAttribute("style", "position:absolute;inset:0;z-index:3");
  stage.appendChild(wo);
  var W = 960;
  var H3 = 560;
  var agentDefs = [
    { id: "a1", nx: 0.28, ny: 0.36, status: "active", backend: "claude" },
    { id: "a2", nx: 0.7, ny: 0.34, status: "active", backend: "codex" },
    { id: "a3", nx: 0.5, ny: 0.64, status: "working", backend: "claude" },
    { id: "a4", nx: 0.8, ny: 0.7, status: "idle", backend: "gemini" },
    { id: "a5", nx: 0.42, ny: 0.48, status: "active", backend: "opencode" },
    { id: "a6", nx: 0.6, ny: 0.52, status: "working", backend: "claude" }
  ];
  window.__agentFxState = agentDefs.map((a4) => ({
    id: a4.id,
    x: a4.nx * W,
    y: a4.ny * H3,
    status: a4.status,
    backend: a4.backend
  }));
  var weights = {
    burn: { a1: 90, a2: 30, a3: 70, a4: 10, a5: 50, a6: 22 },
    failure: { a1: 1, a2: 6, a3: 0, a4: 3, a5: 0, a6: 9 }
  };
  wo.setHeatmapWeights(weights);
  var mission = {
    criticalAgentIds: ["a1", "a3", "a5"],
    criticalSectors: [
      { x: 0.5 * W, y: 0.64 * H3, r: 46, label: "Core" },
      { x: 0.28 * W, y: 0.36 * H3, r: 42, label: "Auth" }
    ]
  };
  wo.setMissionData(mission);
  var earned = [
    { id: "1", kind: "clean_shipment", label: "Clean Shipment", description: "Shipped a task with zero failed sub-agent runs.", icon: "\u{1F4E6}", tier: "bronze", earnedAt: 175e10 },
    { id: "2", kind: "ten_shipments", label: "Ten Down", description: "Completed 10 shipments.", icon: "\u{1F51F}", tier: "silver", earnedAt: 17501e8 },
    { id: "3", kind: "federation_milestone", label: "Federation Online", description: "Grew the federation mesh to a new node milestone.", icon: "\u{1F6F0}\uFE0F", tier: "gold", earnedAt: 17502e8 },
    { id: "4", kind: "zero_failed_day", label: "Flawless Day", description: "Closed a full day with zero failed runs.", icon: "\u2728", tier: "gold", earnedAt: 17503e8 }
  ];
  wo.setAchievements(earned);
  window.__wo = {
    el: wo,
    mission(on) {
      wo.setMissionEnabled(on);
    },
    heat(mode) {
      wo.setHeatmapMode(mode);
    },
    popup() {
      wo.pushAchievement({
        id: "pop1",
        kind: "ship_streak_7day",
        label: "Seven-Day Streak",
        description: "Shipped clean work seven days in a row.",
        icon: "\u{1F525}",
        tier: "gold",
        earnedAt: Date.now()
      });
    },
    modal() {
      wo.openAchievements();
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
