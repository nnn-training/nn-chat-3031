'use strict';
require('dotenv').config();
const pug = require('pug');
const Cookies = require('cookies');
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient({ log: [ 'query' ] });
const util = require('./handler-util');
const { currentThemeKey } = require('../config');

const dayjs = require('dayjs');
const utc = require('dayjs/plugin/utc');
const timezone = require('dayjs/plugin/timezone');
const relativeTime = require('dayjs/plugin/relativeTime');
require('dayjs/locale/ja');
dayjs.locale('ja');
dayjs.extend(utc);
dayjs.extend(timezone);
dayjs.extend(relativeTime);
dayjs.tz.setDefault('Asia/Tokyo');
const crypto = require('node:crypto');

const oneTimeTokenMap = new Map();

async function handle(req, res) {
  const cookies = new Cookies(req, res);
  const currentTheme = cookies.get(currentThemeKey) || 'light';
  const options = { maxAge: 30 * 86400 * 1000 };
  cookies.set(currentThemeKey, currentTheme, options);
  switch (req.method) {
case 'GET':
      // APIリクエストの場合の処理
      if (req.url === '/api/posts') {
        const posts = await prisma.post.findMany({ orderBy: { id: 'asc' } });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(posts));
        return; // ← ここで確実に終了させる
      }
      
      // 通常のHTMLページ表示処理
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      const posts = await prisma.post.findMany({ orderBy: { id: 'asc' } });
      posts.forEach((post) => {
        post.relativeCreatedAt = dayjs(post.createdAt).tz().fromNow();
        post.absoluteCreatedAt = dayjs(post.createdAt).tz().format('YYYY年MM月DD日 HH時mm分ss秒');
      });
      const oneTimeToken = crypto.randomBytes(8).toString('hex');
      oneTimeTokenMap.set(req.user, oneTimeToken);
      res.end(pug.renderFile('./views/posts.pug', { currentTheme, posts, user: req.user, oneTimeToken }));
      break;
    case 'POST':
      let body = '';
      req.on('data', (chunk) => { body += chunk; }).on('end', async () => {
        const params = new URLSearchParams(body);
        const content = params.get('content');
        const requestedOneTimeToken = params.get('oneTimeToken');
        if (!content || !requestedOneTimeToken || oneTimeTokenMap.get(req.user) !== requestedOneTimeToken) {
          util.handleBadRequest(req, res);
          return;
        }

        await prisma.post.create({ data: { content, postedBy: req.user } });

        if (req.user !== 'Snowstorm') {
          const https = require('node:https');
          const listOptions = {
            hostname: 'generativelanguage.googleapis.com',
            path: `/v1/models?key=${process.env.GEMINI_API_KEY}`,
            method: 'GET'
          };

          const reqList = https.request(listOptions, (resList) => {
            let listBody = '';
            resList.on('data', (chunk) => { listBody += chunk; });
            resList.on('end', () => {
              const modelList = JSON.parse(listBody);
              const modelName = modelList.models ? modelList.models[0].name.replace('models/', '') : 'gemini-1.5-flash';
              
              const data = JSON.stringify({ contents: [{ parts: [{ text: `あなたはAIアシスタント「Snowstorm」。ユーザーとの対話をサポートする親しみやすいパートナーとして、自然な会話を行ってください。\nユーザーの発言: ${content}` }] }] });
              const options = {
                hostname: 'generativelanguage.googleapis.com',
                path: `/v1/models/${modelName}:generateContent?key=${process.env.GEMINI_API_KEY}`,
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
              };

              const reqAi = https.request(options, (resAi) => {
                let responseBody = '';
                resAi.on('data', (chunk) => { responseBody += chunk; });
                resAi.on('end', async () => {
                  try {
                    const json = JSON.parse(responseBody);
                    if (json.candidates && json.candidates[0].content) {
                      await prisma.post.create({ data: { content: json.candidates[0].content.parts[0].text, postedBy: 'Snowstorm' } });
                    } else {
                      await prisma.post.create({ data: { content: 'AIが応答を生成できませんでした。', postedBy: 'Snowstorm' } });
                    }
                  } catch (err) {
                    await prisma.post.create({ data: { content: 'システムエラーが発生しました。', postedBy: 'Snowstorm' } });
                  }
                });
              });
              reqAi.end(data);
            });
          });
          reqList.end();
        }

        oneTimeTokenMap.delete(req.user);
        handleRedirectPosts(req, res);
      });
      break;
    default:
      util.handleBadRequest(req, res);
      break;
  }
}

function handleTopPage(req, res) {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(pug.renderFile('./views/top.pug', { user: req.user }));
}

function handleRedirectPosts(req, res) {
  res.writeHead(303, { 'Location': '/posts' });
  res.end();
}

function handleDelete(req, res) {
  switch (req.method) {
    case 'POST':
      let body = '';
      req.on('data', (chunk) => { body += chunk; }).on('end', async () => {
        const params = new URLSearchParams(body);
        const id = parseInt(params.get('id'));
        const requestedOneTimeToken = params.get('oneTimeToken');
        if (!id || !requestedOneTimeToken || oneTimeTokenMap.get(req.user) !== requestedOneTimeToken) {
          util.handleBadRequest(req, res);
          return;
        }
        const post = await prisma.post.findUnique({ where: { id } });
        if (post && (req.user === post.postedBy || req.user === 'admin' || post.postedBy === 'Snowstorm')) {
          await prisma.post.delete({ where: { id } });
          oneTimeTokenMap.delete(req.user);
          handleRedirectPosts(req, res);
        }
      });
      break;
    default:
      util.handleBadRequest(req, res);
      break;
  }
}

module.exports = { handle, handleDelete, handleTopPage };