const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');

async function testDatabase() {
  const SQL = await initSqlJs();

  // Load database
  const filebuffer = fs.readFileSync('./data/speakup.db');
  const db = new SQL.Database(filebuffer);

  console.log('=== DATABASE SCHEMA TEST ===');

  // Check all tables exist
  const tables = [
    'users', 'sessions', 'habit_results', 'scores', 'filler_history',
    'journal', 'camera_alerts', 'personal_records', 'adaptations',
    'challenges', 'teams', 'team_members', 'affiliates', 'affiliate_conversions',
    'user_prefs', 'streak_grace_days', 'milestone_rewards', 'coach_conversations',
    'learning_groups', 'group_members', 'group_challenges', 'group_challenge_participants'
  ];

  console.log('Checking tables:');
  for (const table of tables) {
    try {
      const stmt = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='${table}'`);
      const result = stmt.getAsObject();
      stmt.free();
      console.log(`✓ ${table}: ${result.name ? 'EXISTS' : 'MISSING'}`);
    } catch (err) {
      console.log(`✗ ${table}: ERROR - ${err.message}`);
    }
  }

  console.log('\n=== TESTING NEW MONTH 1 FEATURES ===');

  // Test streak status
  console.log('\n1. Testing Streak Features:');
  try {
    const stmt = db.prepare('SELECT * FROM users WHERE id = 1');
    const user = stmt.getAsObject();
    stmt.free();
    console.log(`✓ User streak: ${user.streak || 0}`);
    console.log(`✓ User longest_streak: ${user.longest_streak || 0}`);
  } catch (err) {
    console.log(`✗ Error checking user streak: ${err.message}`);
  }

  // Test milestone rewards
  console.log('\n2. Testing Milestone Rewards:');
  try {
    const stmt = db.prepare('SELECT COUNT(*) as count FROM milestone_rewards');
    const result = stmt.getAsObject();
    stmt.free();
    console.log(`✓ Milestone rewards table has ${result.count} records`);
  } catch (err) {
    console.log(`✗ Error checking milestone rewards: ${err.message}`);
  }

  // Test coach conversations
  console.log('\n3. Testing AI Coach Conversations:');
  try {
    const stmt = db.prepare('SELECT COUNT(*) as count FROM coach_conversations');
    const result = stmt.getAsObject();
    stmt.free();
    console.log(`✓ Coach conversations table has ${result.count} records`);
  } catch (err) {
    console.log(`✗ Error checking coach conversations: ${err.message}`);
  }

  // Test learning groups
  console.log('\n4. Testing Social Learning Circles:');
  try {
    const stmt = db.prepare('SELECT COUNT(*) as count FROM learning_groups');
    const result = stmt.getAsObject();
    stmt.free();
    console.log(`✓ Learning groups table has ${result.count} records`);
  } catch (err) {
    console.log(`✗ Error checking learning groups: ${err.message}`);
  }

  // Test streak grace days
  console.log('\n5. Testing Streak Grace Days:');
  try {
    const stmt = db.prepare('SELECT COUNT(*) as count FROM streak_grace_days');
    const result = stmt.getAsObject();
    stmt.free();
    console.log(`✓ Streak grace days table has ${result.count} records`);
  } catch (err) {
    console.log(`✗ Error checking streak grace days: ${err.message}`);
  }

  db.close();
}

testDatabase().catch(console.error);