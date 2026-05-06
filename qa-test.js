const axios = require('axios');

const BASE_URL = 'http://localhost:3000';

async function runQATests() {
  console.log('=== SPEAKUP COACH MONTH 1 QA TESTING ===\n');

  const results = {
    passed: 0,
    failed: 0,
    errors: []
  };

  function logResult(testName, success, error = null) {
    if (success) {
      console.log(`✓ ${testName}`);
      results.passed++;
    } else {
      console.log(`✗ ${testName}`);
      results.failed++;
      if (error) results.errors.push(`${testName}: ${error}`);
    }
  }

  try {
    // First create a test user
    console.log('SETTING UP TEST USER');
    try {
      const userResponse = await axios.post(`${BASE_URL}/api/user/create`, {
        name: 'QA Test User',
        goal: 'Improve public speaking confidence',
        nativeLanguage: 'English',
        speakingContext: 'both'
      });
      logResult('POST /api/user/create', userResponse.status === 200);
      console.log('   Test user created successfully');
    } catch (error) {
      if (error.response?.status === 500 && error.response?.data?.error?.includes('UNIQUE constraint failed')) {
        logResult('POST /api/user/create', true, 'User already exists (expected)');
      } else {
        logResult('POST /api/user/create', false, error.message);
      }
    }

    // Test 1: Basic API connectivity
    console.log('1. BASIC API CONNECTIVITY');
    try {
      const response = await axios.get(`${BASE_URL}/api/user`);
      logResult('GET /api/user', response.status === 200);
    } catch (error) {
      logResult('GET /api/user', false, error.message);
    }

    // Test 2: Streak Status API
    console.log('\n2. DAILY HABIT STREAKS & REWARDS');
    try {
      const response = await axios.get(`${BASE_URL}/api/streak/status`);
      logResult('GET /api/streak/status', response.status === 200);
      if (response.data) {
        console.log(`   Current streak: ${response.data.currentStreak || 0}`);
        console.log(`   Longest streak: ${response.data.longestStreak || 0}`);
        console.log(`   Grace days available: ${response.data.graceDaysAvailable || 0}`);
      }
    } catch (error) {
      logResult('GET /api/streak/status', false, error.message);
    }

    // Test 3: Streak Recovery
    try {
      const response = await axios.post(`${BASE_URL}/api/streak/recovery`, {
        useGraceDay: true
      });
      logResult('POST /api/streak/recovery', response.status === 200);
    } catch (error) {
      logResult('POST /api/streak/recovery', false, error.message);
    }

    // Test 4: Milestone Rewards
    console.log('\n3. MILESTONE REWARDS');
    try {
      const response = await axios.get(`${BASE_URL}/api/rewards/unclaimed`);
      logResult('GET /api/rewards/unclaimed', response.status === 200);
      console.log(`   Unclaimed rewards: ${response.data?.length || 0}`);
    } catch (error) {
      logResult('GET /api/rewards/unclaimed', false, error.message);
    }

    // Test 5: Claim Reward
    try {
      // First get unclaimed rewards
      const rewardsResponse = await axios.get(`${BASE_URL}/api/rewards/unclaimed`);
      if (rewardsResponse.data && rewardsResponse.data.length > 0) {
        const rewardId = rewardsResponse.data[0].id;
        const response = await axios.post(`${BASE_URL}/api/rewards/claim/${rewardId}`);
        logResult('POST /api/rewards/claim/:id', response.status === 200);
      } else {
        logResult('POST /api/rewards/claim/:id', true, 'No rewards to claim (expected)');
      }
    } catch (error) {
      logResult('POST /api/rewards/claim/:id', false, error.message);
    }

    // Test 6: AI Coach Conversations
    console.log('\n4. PERSONALIZED AI COACH CONVERSATIONS');
    try {
      const response = await axios.post(`${BASE_URL}/api/coach/chat/start`, {
        type: 'test_conversation',
        message: 'Hello coach, I need help with my speaking practice.'
      });
      logResult('POST /api/coach/chat/start', response.status === 200);
      if (response.data && response.data.conversationId) {
        console.log(`   Conversation started: ${response.data.conversationId}`);

        // Test continuing conversation
        try {
          const continueResponse = await axios.post(`${BASE_URL}/api/coach/chat/${response.data.conversationId}`, {
            message: 'Can you give me tips for better pacing?'
          });
          logResult('POST /api/coach/chat/:id (continue)', continueResponse.status === 200);
        } catch (error) {
          logResult('POST /api/coach/chat/:id (continue)', false, error.message);
        }
      }
    } catch (error) {
      logResult('POST /api/coach/chat/start', false, error.message);
    }

    // Test 7: Get Coach Conversations
    try {
      const response = await axios.get(`${BASE_URL}/api/coach/conversations`);
      logResult('GET /api/coach/conversations', response.status === 200);
      console.log(`   Total conversations: ${response.data?.length || 0}`);
    } catch (error) {
      logResult('GET /api/coach/conversations', false, error.message);
    }

    // Test 8: Social Learning Circles
    console.log('\n5. SOCIAL LEARNING CIRCLES');
    try {
      const response = await axios.post(`${BASE_URL}/api/groups/create`, {
        name: 'Test Speaking Group',
        description: 'A test group for QA',
        goals: ['Improve confidence', 'Practice regularly']
      });
      logResult('POST /api/groups/create', response.status === 200);
      if (response.data && response.data.groupId) {
        console.log(`   Group created: ${response.data.groupId}`);

        // Test getting groups
        try {
          const groupsResponse = await axios.get(`${BASE_URL}/api/groups`);
          logResult('GET /api/groups', groupsResponse.status === 200);
          console.log(`   Available groups: ${groupsResponse.data?.length || 0}`);
        } catch (error) {
          logResult('GET /api/groups', false, error.message);
        }

        // Test joining group
        try {
          const joinResponse = await axios.post(`${BASE_URL}/api/groups/join/${response.data.groupId}`);
          logResult('POST /api/groups/join/:id', joinResponse.status === 200);
        } catch (error) {
          logResult('POST /api/groups/join/:id', false, error.message);
        }

        // Test group progress
        try {
          const progressResponse = await axios.get(`${BASE_URL}/api/groups/${response.data.groupId}/progress`);
          logResult('GET /api/groups/:id/progress', progressResponse.status === 200);
        } catch (error) {
          logResult('GET /api/groups/:id/progress', false, error.message);
        }
      }
    } catch (error) {
      logResult('POST /api/groups/create', false, error.message);
    }

    // Test 9: Error Handling
    console.log('\n6. ERROR HANDLING');
    try {
      await axios.get(`${BASE_URL}/api/nonexistent`);
      logResult('GET /api/nonexistent (404)', false, 'Should have returned 404');
    } catch (error) {
      logResult('GET /api/nonexistent (404)', error.response?.status === 404);
    }

    try {
      await axios.post(`${BASE_URL}/api/streak/recovery`, {});
      logResult('POST /api/streak/recovery (invalid)', false, 'Should have validated input');
    } catch (error) {
      logResult('POST /api/streak/recovery (invalid)', error.response?.status === 400);
    }

    // Test 10: Data Persistence
    console.log('\n7. DATA PERSISTENCE');
    try {
      // Get initial streak status
      const initialResponse = await axios.get(`${BASE_URL}/api/streak/status`);
      const initialStreak = initialResponse.data?.currentStreak || 0;

      // Simulate completing a session (this would normally be done through the UI)
      // For testing, we'll just check if the data persists across requests
      const secondResponse = await axios.get(`${BASE_URL}/api/streak/status`);
      const secondStreak = secondResponse.data?.currentStreak || 0;

      logResult('Data persistence across requests', initialStreak === secondStreak);
    } catch (error) {
      logResult('Data persistence across requests', false, error.message);
    }

  } catch (error) {
    console.error('Test suite failed:', error.message);
  }

  // Summary
  console.log('\n=== TEST SUMMARY ===');
  console.log(`Passed: ${results.passed}`);
  console.log(`Failed: ${results.failed}`);
  console.log(`Total: ${results.passed + results.failed}`);

  if (results.errors.length > 0) {
    console.log('\n=== ERRORS ===');
    results.errors.forEach(error => console.log(`- ${error}`));
  }

  console.log('\n=== CRON JOB TESTING ===');
  console.log('Note: Cron jobs run automatically. Check server logs for:');
  console.log('- Daily streak reminders (9 AM)');
  console.log('- Weekly AI coach check-ins (Sundays 10 AM)');
  console.log('- Milestone celebrations (6 PM)');

  return results;
}

runQATests().catch(console.error);