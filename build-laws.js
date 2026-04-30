// 関係法令集HTMLからテキストを抽出し、法令データベース(JSON)を生成する
const fs = require('fs');
const path = require('path');

const LAWS_DIR = path.join(__dirname, '..', '関係法令集');
const OUT_FILE = path.join(__dirname, 'public', 'laws-db.js');

// 安全衛生に特に重要な法令（優先度高）
const PRIORITY_LAWS = [
  '労働安全衛生法', '労働安全衛生規則', '労働安全衛生法施行令',
  'クレーン等安全規則', '石綿障害予防規則', '粉じん障害防止規則',
  '建設業法', '建築基準法', '消防法',
  '労働基準法', '労働者災害補償保険法',
  '電気事業法'
];

function stripHtml(html) {
  // スクリプトとスタイルを除去
  var text = html.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '');
  text = text.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '');
  // brを改行に
  text = text.replace(/<br\s*\/?>/gi, '\n');
  // タグを除去
  text = text.replace(/<[^>]+>/g, '');
  // HTMLエンティティ
  text = text.replace(/&nbsp;/g, ' ');
  text = text.replace(/&amp;/g, '&');
  text = text.replace(/&lt;/g, '<');
  text = text.replace(/&gt;/g, '>');
  text = text.replace(/&quot;/g, '"');
  text = text.replace(/&#(\d+);/g, function(_, n) { return String.fromCharCode(n); });
  // 連続空白・空行を整理
  text = text.replace(/[ \t]+/g, ' ');
  text = text.replace(/\n\s*\n/g, '\n');
  return text.trim();
}

function extractTitle(html) {
  var m = html.match(/<title>([^<]+)<\/title>/i);
  return m ? m[1].trim() : '';
}

// 条文ごとに分割
function splitArticles(text) {
  var articles = [];
  var lines = text.split('\n');
  var current = { heading: '', body: '' };

  for (var i = 0; i < lines.length; i++) {
    var line = lines[i].trim();
    if (!line) continue;

    // 「第XX条」パターンの検出
    if (line.match(/^第[一二三四五六七八九十百千\d]+条(\s|の|$)/) ||
        line.match(/^（[^）]{1,30}）$/) && lines[i+1] && lines[i+1].trim().match(/^第/)) {
      if (current.body.length > 10) {
        articles.push({ heading: current.heading, body: current.body.trim() });
      }
      current = { heading: line, body: line + '\n' };
    } else {
      current.body += line + '\n';
    }
  }
  if (current.body.length > 10) {
    articles.push({ heading: current.heading, body: current.body.trim() });
  }

  // 条文が抽出できなかった場合、チャンクに分割
  if (articles.length < 3) {
    articles = [];
    var chunk = '';
    for (var j = 0; j < lines.length; j++) {
      chunk += lines[j] + '\n';
      if (chunk.length > 2000) {
        articles.push({ heading: '', body: chunk.trim() });
        chunk = '';
      }
    }
    if (chunk.trim()) articles.push({ heading: '', body: chunk.trim() });
  }

  return articles;
}

console.log('関係法令集HTML → 法令データベース変換\n');

var files = fs.readdirSync(LAWS_DIR).filter(function(f) { return f.endsWith('.html'); });
console.log('対象ファイル: ' + files.length + '件');

var laws = [];
var totalChars = 0;
var skipped = 0;

files.forEach(function(file) {
  var html = fs.readFileSync(path.join(LAWS_DIR, file), 'utf-8');
  var title = extractTitle(html) || file.replace('.html', '');
  var text = stripHtml(html);

  if (text.length < 50) {
    skipped++;
    return;
  }

  var isPriority = PRIORITY_LAWS.some(function(p) { return title.indexOf(p) >= 0; });

  // 重要法令はより細かく、それ以外は要約的に
  var maxLen = isPriority ? 30000 : 8000;
  if (text.length > maxLen) {
    text = text.substring(0, maxLen);
  }

  var articles = splitArticles(text);

  laws.push({
    title: title,
    file: file,
    priority: isPriority ? 1 : 0,
    articles: articles,
    charCount: text.length
  });

  totalChars += text.length;
  console.log((isPriority ? '★ ' : '  ') + title + ' (' + text.length + '文字, ' + articles.length + '条文)');
});

console.log('\n合計: ' + laws.length + '法令, ' + totalChars + '文字 (スキップ: ' + skipped + ')');

// JavaScriptファイルとして出力（グローバル変数に格納）
var output = '// 自動生成: 関係法令集データベース\n'
  + '// 生成日時: ' + new Date().toISOString() + '\n'
  + 'var LAWS_DB = ' + JSON.stringify(laws, null, 0) + ';\n';

fs.writeFileSync(OUT_FILE, output, 'utf-8');
console.log('\n出力: ' + OUT_FILE + ' (' + Math.round(output.length / 1024) + ' KB)');
