/**
 * Shared mutable runtime state.
 *
 * Original server.js ek hi file thi, isliye ye sab top-level `let` bindings
 * thi jo kisi bhi function se read/reassign ho jaati thi. Modules me todne ke
 * baad CommonJS ke destructured imports ki value copy ho jaati hai (live binding
 * nahi milti) — isliye har binding yahan getter/setter ke through expose hoti hai.
 * Behaviour bilkul wahi hai: ek hi shared value, sab modules se mutable.
 */
const path = require("path");
const { APP_ROOT } = require("./config");
const { DEFAULT_ADMIN_SETTINGS } = require("./settings/defaults");

// web-push optional dependency hai — na mile to null (original try/catch jaisa hi)
let webPush = null;
try {
  webPush = require("web-push");
} catch (_) {
  webPush = null;
}

let mongoClient = null;
let db = null; // MongoDB database handle;
let adminSettings = { ...DEFAULT_ADMIN_SETTINGS };
let pushSubscriptionsList = [];
let notificationsList = [];
let announcement = null;
let paymentsCache = null;
let paymentsDirty = false;
let paymentsWriteTimer = null;
let predCache = { at: 0, prediction: null, fetched_at: "" };
let tgOffset = 0;
let tgPolling = false;
let marketCache = { at: 0, items: [], updated_at: "" };

function getWebPush() {
  return webPush;
}
function setWebPush(v) {
  webPush = v;
}

function getMongoClient() {
  return mongoClient;
}
function setMongoClient(v) {
  mongoClient = v;
}

function getDb() {
  return db;
}
function setDb(v) {
  db = v;
}

function getAdminSettings() {
  return adminSettings;
}
function setAdminSettings(v) {
  adminSettings = v;
}

function getPushSubscriptionsList() {
  return pushSubscriptionsList;
}
function setPushSubscriptionsList(v) {
  pushSubscriptionsList = v;
}

function getNotificationsList() {
  return notificationsList;
}
function setNotificationsList(v) {
  notificationsList = v;
}

function getAnnouncement() {
  return announcement;
}
function setAnnouncement(v) {
  announcement = v;
}

function getPaymentsCache() {
  return paymentsCache;
}
function setPaymentsCache(v) {
  paymentsCache = v;
}

function getPaymentsDirty() {
  return paymentsDirty;
}
function setPaymentsDirty(v) {
  paymentsDirty = v;
}

function getPaymentsWriteTimer() {
  return paymentsWriteTimer;
}
function setPaymentsWriteTimer(v) {
  paymentsWriteTimer = v;
}

function getPredCache() {
  return predCache;
}
function setPredCache(v) {
  predCache = v;
}

function getTgOffset() {
  return tgOffset;
}
function setTgOffset(v) {
  tgOffset = v;
}

function getTgPolling() {
  return tgPolling;
}
function setTgPolling(v) {
  tgPolling = v;
}

function getMarketCache() {
  return marketCache;
}
function setMarketCache(v) {
  marketCache = v;
}

module.exports = {
  getWebPush,
  setWebPush,
  getMongoClient,
  setMongoClient,
  getDb,
  setDb,
  getAdminSettings,
  setAdminSettings,
  getPushSubscriptionsList,
  setPushSubscriptionsList,
  getNotificationsList,
  setNotificationsList,
  getAnnouncement,
  setAnnouncement,
  getPaymentsCache,
  setPaymentsCache,
  getPaymentsDirty,
  setPaymentsDirty,
  getPaymentsWriteTimer,
  setPaymentsWriteTimer,
  getPredCache,
  setPredCache,
  getTgOffset,
  setTgOffset,
  getTgPolling,
  setTgPolling,
  getMarketCache,
  setMarketCache,
};
