import { describe, expect, it } from "vitest";

import {
  extractJapaneseSentences,
  isTranslationCandidate,
} from "../src/content/extractor";

describe("content sentence extraction", () => {
  it("splits Japanese text into sentences in page order with the nearest heading", () => {
    document.body.innerHTML = `
      <h1>概要</h1>
      <p id="first">これは最初の文章です。これは二番目の文章です！</p>
      <h2>詳細</h2>
      <p id="second">最後の対象文章になります。</p>
    `;

    const candidates = extractJapaneseSentences(document.body);

    expect(candidates.map(({ id, text, sectionHeading }) => ({
      id,
      text,
      sectionHeading,
    }))).toEqual([
      {
        id: "sentence-0001",
        text: "これは最初の文章です。",
        sectionHeading: "概要",
      },
      {
        id: "sentence-0002",
        text: "これは二番目の文章です！",
        sectionHeading: "概要",
      },
      {
        id: "sentence-0003",
        text: "最後の対象文章になります。",
        sectionHeading: "詳細",
      },
    ]);
    expect(candidates[0]?.node).toBe(document.querySelector("#first")?.firstChild);
  });

  it("excludes controls, code, navigation, editable, hidden, and aria-hidden text", () => {
    document.body.innerHTML = `
      <main>
        <p>これは抽出される十分な長さの文章です。</p>
        <script>これはスクリプト内の文章です。</script>
        <style>.x::after { content: "これはスタイルです。" }</style>
        <noscript>これはノースクリプト内の文章です。</noscript>
        <pre>これは整形済みの文章です。</pre>
        <code>これはコード内の文章です。</code>
        <kbd>これはキー操作の文章です。</kbd>
        <samp>これは出力例の文章です。</samp>
        <textarea>これはテキストエリア内の文章です。</textarea>
        <select><option>これは選択肢内の文章です。</option></select>
        <button>これはボタン内の文章です。</button>
        <form><label>これはフォーム内の文章です。</label></form>
        <nav>これはナビゲーション内の文章です。</nav>
        <div contenteditable="true">これは編集可能な文章です。</div>
        <div hidden>これはhidden属性の文章です。</div>
        <div style="display: none">これは非表示の文章です。</div>
        <div style="visibility: hidden">これも非表示の文章です。</div>
        <div style="opacity: 0">これは透明な文章です。</div>
        <iframe>これはiframeのfallback文章です。</iframe>
        <canvas>これはcanvasのfallback文章です。</canvas>
        <div aria-hidden="true"><span>これはaria hiddenの文章です。</span></div>
        <div style="visibility: hidden">
          <p style="visibility: visible">これは子要素で再表示された文章です。</p>
        </div>
      </main>
    `;

    expect(extractJapaneseSentences(document.body).map(({ text }) => text)).toEqual([
      "これは抽出される十分な長さの文章です。",
      "これは子要素で再表示された文章です。",
    ]);
  });

  it("filters short UI labels and non-Japanese values", () => {
    expect(isTranslationCandidate("設定")).toBe(false);
    expect(isTranslationCandidate("https://example.com/path")).toBe(false);
    expect(isTranslationCandidate("123,456")).toBe(false);
    expect(isTranslationCandidate("A plain English sentence.")).toBe(false);
    expect(isTranslationCandidate("これは学習に適した文章です。")).toBe(true);
  });
});
