import Database, { Database as DatabaseType } from "better-sqlite3";
import path from "path";
import fs from "fs";

const dataDir = path.join(__dirname, "..", "data");
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const dbPath = path.join(dataDir, "price-game.db");
const db: DatabaseType = new Database(dbPath);

// Production SQLite PRAGMAs
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");
db.pragma("busy_timeout = 5000");
db.pragma("synchronous = NORMAL");
db.pragma("cache_size = -64000");
db.pragma("mmap_size = 268435456");
db.pragma("temp_store = MEMORY");

// === Base schema (idempotent) ===

db.exec(`
  CREATE TABLE IF NOT EXISTS products (
    id INTEGER PRIMARY KEY,
    asin TEXT,
    title TEXT NOT NULL,
    image_url TEXT,
    description TEXT,
    price_cents INTEGER NOT NULL,
    category TEXT,
    is_active BOOLEAN DEFAULT 1
  );

  CREATE TABLE IF NOT EXISTS game_sessions (
    id TEXT PRIMARY KEY,
    current_round INTEGER DEFAULT 1,
    total_score INTEGER DEFAULT 0,
    selected_products TEXT,
    started_at TEXT,
    completed_at TEXT
  );

  CREATE TABLE IF NOT EXISTS game_rounds (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    round_number INTEGER NOT NULL,
    product_id INTEGER NOT NULL,
    guessed_price_cents INTEGER,
    score INTEGER,
    guessed_at TEXT,
    FOREIGN KEY (session_id) REFERENCES game_sessions(id),
    FOREIGN KEY (product_id) REFERENCES products(id)
  );

  -- Legacy "leaderboard" table — kept in the base schema so historical
  -- migrations (v3 game_mode, v8 user_id, v50 moderation columns) still
  -- run cleanly on a fresh install. Migration v53 drops the table after
  -- all those migrations have completed.
  CREATE TABLE IF NOT EXISTS leaderboard (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    player_name TEXT NOT NULL,
    session_id TEXT,
    score INTEGER NOT NULL,
    played_at TEXT
  );

  CREATE TABLE IF NOT EXISTS mp_rooms (
    code TEXT PRIMARY KEY,
    host_player_id TEXT NOT NULL,
    creator_player_id TEXT,
    game_mode TEXT NOT NULL DEFAULT 'classic',
    category TEXT,
    status TEXT NOT NULL DEFAULT 'lobby',
    current_round INTEGER DEFAULT 0,
    total_rounds INTEGER DEFAULT 10,
    selected_products TEXT,
    round_data TEXT,
    created_at TEXT NOT NULL,
    finished_at TEXT
  );

  CREATE TABLE IF NOT EXISTS mp_players (
    id TEXT PRIMARY KEY,
    room_code TEXT NOT NULL,
    display_name TEXT NOT NULL,
    avatar TEXT NOT NULL,
    token TEXT NOT NULL UNIQUE,
    is_host INTEGER DEFAULT 0,
    is_kicked INTEGER DEFAULT 0,
    total_score INTEGER DEFAULT 0,
    connected INTEGER DEFAULT 1,
    joined_at TEXT NOT NULL,
    FOREIGN KEY (room_code) REFERENCES mp_rooms(code)
  );

  CREATE TABLE IF NOT EXISTS mp_guesses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    room_code TEXT NOT NULL,
    player_id TEXT NOT NULL,
    round_number INTEGER NOT NULL,
    guess_data TEXT,
    score INTEGER DEFAULT 0,
    submitted_at TEXT,
    FOREIGN KEY (room_code) REFERENCES mp_rooms(code),
    FOREIGN KEY (player_id) REFERENCES mp_players(id),
    UNIQUE(room_code, player_id, round_number)
  );

  CREATE TABLE IF NOT EXISTS mp_leaderboard (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    player_name TEXT NOT NULL,
    room_code TEXT,
    score INTEGER NOT NULL,
    placement INTEGER NOT NULL,
    players_count INTEGER NOT NULL,
    game_mode TEXT NOT NULL,
    played_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS schema_version (
    version INTEGER PRIMARY KEY
  );

  CREATE TABLE IF NOT EXISTS shared_games (
    id TEXT PRIMARY KEY,
    game_mode TEXT NOT NULL,
    total_score INTEGER NOT NULL,
    per_round_max INTEGER NOT NULL,
    player_name TEXT,
    round_data TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_shared_games_created ON shared_games(created_at);
`);

// === Default legal documents ===

const DEFAULT_PRIVACY_POLICY = `# Privacy Policy

**Last Updated: March 17, 2026**

Thank you for using Price Games ("we," "us," or "our"). This Privacy Policy explains how we collect, use, disclose, and safeguard your information when you visit our website at price.games (the "Site") and use our services, including our games, giveaways, and related features.

## 1. Information We Collect

### Information You Provide
- **Account Information:** When you register, we collect your username, email address, and password (stored as a secure hash).
- **Third-Party Sign-In:** If you sign in using a third-party provider, we receive limited profile data from that provider:
  - **Login with Amazon:** Your name, email address, and Amazon user ID (via the Amazon "profile" scope). See [Login with Amazon Privacy Notice](https://www.amazon.com/gp/help/customer/display.html?nodeId=GX7NJQ4ZB8MHFRNJ) for more details.
  - **Google Sign-In:** Your name, email address, and Google user ID.
  - **Facebook Login:** Your name, email address, and Facebook user ID.
- **Game Data:** Your game scores, round history, game mode preferences, and leaderboard entries.
- **Giveaway Participation:** If you participate in a giveaway or sweepstakes, we collect information needed to determine eligibility and deliver prizes.

### Information Collected Automatically
- **Usage Data:** Pages visited, game sessions played, scores, and feature interactions.
- **Device & Browser Data:** IP address, browser type, operating system, and device identifiers.
- **Cookies & Similar Technologies:** We use cookies to maintain your session, remember preferences (such as currency selection), and understand how the Site is used. See Section 6 for details.
- **WebSocket Data:** Our multiplayer features use real-time WebSocket connections (Socket.IO). Connection metadata (such as connection timestamps and room participation) is processed to deliver the multiplayer experience.

### Chrome Extension
If you install our optional Chrome extension, it allows authorized administrators to import product data from Amazon. The extension does not collect personal browsing data from users.

## 2. How We Use Your Information

We use the information we collect to:

- Operate, maintain, and improve the Site and our games
- Create and manage your account
- Track scores, maintain leaderboards, and calculate game statistics
- Administer giveaways and sweepstakes, including determining eligibility, selecting winners, and delivering prizes
- Process and serve affiliate links through the Amazon Associates Program
- Analyze usage patterns to improve game modes and user experience
- Communicate with you about your account, giveaway results, or service updates
- Detect and prevent fraud, abuse, or security incidents

## 3. Affiliate Links & Amazon Associates

Price Games is a participant in the **Amazon Services LLC Associates Program**, an affiliate advertising program designed to provide a means for sites to earn advertising fees by advertising and linking to Amazon.com.

- Product information displayed on the Site (images, titles, prices) is sourced from Amazon
- When you interact with product links or content, we may process data to serve affiliate links
- Amazon may collect additional information when you visit their site via our links; please review [Amazon's Privacy Notice](https://www.amazon.com/gp/help/customer/display.html?nodeId=GX7NJQ4ZB8MHFRNJ) for details
- We earn commissions on qualifying purchases made through these links, at no additional cost to you

## 4. Giveaways & Sweepstakes

When we run giveaways or sweepstakes:

- Participation requires a registered account with a verified email address
- We collect and retain information necessary to administer the giveaway, verify eligibility, select winners, and fulfill prizes
- Winner information (username only) may be publicly displayed on the Site
- Prize fulfillment may require sharing limited information (e.g., email address) with prize providers
- Each giveaway may have additional rules that supplement this policy; those rules will be made available alongside the giveaway details

## 5. How We Share Your Information

We do **not** sell your personal information. We may share information in these limited circumstances:

- **Leaderboards & Public Profiles:** Your username and game scores are displayed publicly on leaderboards
- **Giveaway Administration:** Winner usernames may be publicly announced; limited contact information may be shared with prize providers for fulfillment
- **Service Providers:** We use third-party services for email delivery (e.g., transactional emails for account verification and password resets)
- **Third-Party Authentication Providers:** When you use a third-party sign-in (Login with Amazon, Google, or Facebook), the provider may collect information through its own cookies and tracking technologies during the sign-in process. We do not control data collection by these providers; please review their respective privacy policies.
- **Third-Party Content & Advertising:** Third parties, including Amazon and other advertisers, may serve content on the Site, collect information directly from visitors, and place or recognize cookies on your browser
- **Legal Requirements:** We may disclose information if required by law, regulation, legal process, or governmental request
- **Safety & Security:** We may share information to protect the rights, property, or safety of Price Games, our users, or others

## 6. Cookies & Tracking

We use the following types of cookies:

- **Essential Cookies:** Required for authentication, session management, and core functionality. These cannot be disabled while using the Site.
- **Preference Cookies:** Store your settings such as currency selection and cookie consent status.
- **Analytics Cookies:** Help us understand usage patterns to improve the Site.

You can manage cookie preferences through the cookie consent banner shown on your first visit. Most browsers also allow you to control cookies through their settings.

## 7. Communications

We may send you transactional emails related to your account (e.g., email verification, password resets, giveaway winner notifications). These are necessary for the operation of the Site and are not marketing communications.

We do not currently send marketing emails. If we begin sending marketing communications in the future, we will provide you with the ability to opt out of such communications. We will never share your information with third parties for their own marketing purposes without your explicit consent.

## 8. Data Retention

- **Account Data:** Retained as long as your account is active. You may request deletion by contacting us.
- **Game Data:** Game session history and scores are retained indefinitely to maintain leaderboard integrity.
- **Giveaway Records:** Retained as required for legal and tax compliance purposes.
- **Session Tokens:** Automatically expire and are periodically cleaned up.

## 9. Data Security

We implement reasonable security measures to protect your information, including:

- Passwords are hashed using industry-standard algorithms (bcrypt)
- Session tokens are cryptographically generated and stored securely
- Administrative access is protected by separate authentication with session expiry and rate limiting
- The Site uses HTTPS encryption for all data in transit
- We apply security headers and rate limiting to protect against common web attacks

No method of transmission over the Internet is 100% secure. While we strive to use commercially acceptable means to protect your information, we cannot guarantee absolute security.

## 10. Children's Privacy

Price Games is not directed at children under 13. We do not knowingly collect personal information from children under 13. If you are a parent or guardian and believe your child has provided us with personal information, please contact us and we will delete such information.

## 11. Your Rights & Data Deletion

Depending on your jurisdiction, you may have the right to:

- Access the personal information we hold about you
- Request correction of inaccurate information
- Request deletion of your personal information
- Object to or restrict certain processing
- Data portability

**To request data deletion or exercise any of these rights**, please email us at the address below. Upon receiving a verified deletion request, we will delete your personal information within 30 days, except where we are required by law to retain it (e.g., giveaway tax records). If you signed in using Login with Amazon, Google, or Facebook, we will delete all data received from those providers except your name and email address, unless you specifically request deletion of those as well.

## 12. Third-Party Links

The Site may contain links to third-party websites (including Amazon). We are not responsible for the privacy practices of these external sites. We encourage you to review their privacy policies.

## 13. Changes to This Policy

We may update this Privacy Policy from time to time. We will notify you of material changes by updating the "Last Updated" date at the top of this policy. Your continued use of the Site after changes are posted constitutes acceptance of the updated policy.

## 14. Contact Us

If you have questions about this Privacy Policy or wish to exercise your data rights, please contact us at:

**Email:** privacy@price.games
`;

const DEFAULT_TERMS_OF_SERVICE = `# Terms of Service

**Last Updated: March 17, 2026**

Welcome to Price Games. Please read these Terms of Service ("Terms") carefully before using the website at price.games (the "Site") operated by Price Games ("we," "us," or "our").

By accessing or using the Site, you agree to be bound by these Terms. If you do not agree, do not use the Site.

## 1. Eligibility

You must be at least 13 years old to use the Site. By using the Site, you represent that you meet this age requirement. Some features (such as giveaways) may have additional eligibility requirements.

## 2. Accounts

### Registration
You may register for an account using an email and password or through a third-party sign-in provider. You are responsible for:

- Maintaining the confidentiality of your login credentials
- All activities that occur under your account
- Providing accurate and current information

### Username Policy
Usernames must not be offensive, misleading, or impersonate another person or entity. We reserve the right to remove or change usernames that violate this policy.

### Account Termination
We may suspend or terminate your account at our discretion if you violate these Terms, engage in fraudulent activity, or abuse the Site or its features.

## 3. Game Rules & Fair Play

- Games are provided for entertainment purposes
- You agree not to use bots, scripts, automation, or any form of cheating to gain an unfair advantage
- You agree not to exploit bugs or glitches; please report them to us instead
- We reserve the right to void scores, remove leaderboard entries, and suspend accounts for violations of fair play
- Game rules, scoring, and available modes may change at any time

## 4. Giveaways & Sweepstakes

From time to time, we may offer giveaways, sweepstakes, or other promotional events ("Promotions"). The following general rules apply to all Promotions unless otherwise stated in specific Promotion rules:

### Eligibility
- You must have a registered account with a verified email address
- You must meet any minimum score or activity thresholds specified for the Promotion
- Promotions are void where prohibited by law
- Employees, contractors, and immediate family members of Price Games may be excluded

### Entry
- No purchase is necessary to enter or win any Promotion
- Entry is earned through gameplay activity as described in the specific Promotion details
- One account per person; creating multiple accounts to increase chances of winning is prohibited and grounds for disqualification

### Winner Selection
- Winners may be selected randomly from qualifying participants, based on game performance, or by other methods described in the Promotion rules
- Winners will be notified via their registered email address
- If a winner does not respond within the time specified in the notification (typically 7 days), an alternate winner may be selected

### Prizes
- Prizes are non-transferable and non-exchangeable unless otherwise stated
- We reserve the right to substitute a prize of equal or greater value
- Winners are solely responsible for any taxes, fees, or other obligations associated with receiving a prize
- Prize fulfillment may take up to 30 days from winner confirmation

### General
- We reserve the right to modify, suspend, or cancel any Promotion at any time for any reason
- We reserve the right to disqualify any participant who we reasonably believe has violated these Terms or the specific Promotion rules
- Individual Promotions may have additional rules that supplement these Terms; in the event of a conflict, the specific Promotion rules prevail

## 5. Affiliate Links & Product Information

- The Site displays product information sourced from Amazon and other retailers for gameplay purposes
- Product prices shown may not reflect current real-time pricing
- We are a participant in the Amazon Services LLC Associates Program and earn commissions from qualifying purchases made through affiliate links
- **As an Amazon Associate, this site earns from qualifying purchases**
- Product links on the Site may be affiliate links
- We do not sell products directly; all purchases are made through third-party retailers

## 6. Intellectual Property

- The Site, including its design, code, game mechanics, graphics, and content (excluding third-party product information), is owned by Price Games and protected by applicable intellectual property laws
- Product images, titles, and descriptions displayed on the Site are the property of their respective owners and are used under applicable affiliate program terms
- You may not copy, modify, distribute, or create derivative works from our content without our express written permission

## 7. User Conduct

You agree not to:

- Use the Site for any unlawful purpose
- Attempt to gain unauthorized access to any part of the Site, other accounts, or connected systems
- Interfere with or disrupt the Site or servers
- Use automated means (bots, scrapers, etc.) to access or interact with the Site without our permission
- Harass, abuse, or harm other users
- Upload or transmit malicious code
- Circumvent any security measures or access controls
- Misrepresent your identity or affiliation

## 8. Disclaimer of Warranties

THE SITE AND ALL CONTENT, FEATURES, AND SERVICES ARE PROVIDED "AS IS" AND "AS AVAILABLE" WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO IMPLIED WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE, AND NON-INFRINGEMENT.

We do not warrant that:

- The Site will be uninterrupted, error-free, or secure
- Game scores or leaderboard data will be preserved indefinitely
- Product prices displayed are accurate or current
- Any errors or defects will be corrected

## 9. Limitation of Liability

TO THE MAXIMUM EXTENT PERMITTED BY LAW, PRICE GAMES AND ITS OPERATORS, OFFICERS, EMPLOYEES, AND AGENTS SHALL NOT BE LIABLE FOR ANY INDIRECT, INCIDENTAL, SPECIAL, CONSEQUENTIAL, OR PUNITIVE DAMAGES, INCLUDING BUT NOT LIMITED TO LOSS OF PROFITS, DATA, OR GOODWILL, ARISING OUT OF OR IN CONNECTION WITH YOUR USE OF THE SITE.

IN NO EVENT SHALL OUR TOTAL LIABILITY EXCEED THE GREATER OF (A) THE AMOUNT YOU HAVE PAID US IN THE TWELVE (12) MONTHS PRIOR TO THE CLAIM, OR (B) ONE HUNDRED U.S. DOLLARS ($100).

## 10. Indemnification

You agree to indemnify, defend, and hold harmless Price Games and its operators from any claims, damages, losses, liabilities, and expenses (including reasonable attorney's fees) arising out of or relating to your use of the Site, your violation of these Terms, or your violation of any rights of a third party.

## 11. Modifications

We reserve the right to modify these Terms at any time. Changes will be effective when posted on the Site with an updated "Last Updated" date. Your continued use of the Site after changes are posted constitutes your acceptance of the revised Terms.

## 12. Governing Law

These Terms shall be governed by and construed in accordance with the laws of the United States, without regard to conflict of law provisions.

## 13. Severability

If any provision of these Terms is found to be unenforceable or invalid, that provision will be limited or eliminated to the minimum extent necessary, and the remaining provisions will remain in full force and effect.

## 14. Entire Agreement

These Terms, together with the Privacy Policy and any specific Promotion rules, constitute the entire agreement between you and Price Games regarding your use of the Site.

## 15. Contact Us

If you have questions about these Terms, please contact us at:

**Email:** legal@price.games
`;

// === Versioned migrations ===

type Migration = { version: number; sql: string };

const migrations: Migration[] = [
  {
    version: 1,
    sql: `
      ALTER TABLE game_sessions ADD COLUMN game_mode TEXT DEFAULT 'classic';
      ALTER TABLE game_sessions ADD COLUMN round_data TEXT;
      ALTER TABLE game_rounds ADD COLUMN guess_data TEXT;
      ALTER TABLE leaderboard ADD COLUMN game_mode TEXT DEFAULT 'classic';
      ALTER TABLE products ADD COLUMN last_used_at TEXT;
      ALTER TABLE products ADD COLUMN scraped_at TEXT;
      ALTER TABLE products ADD COLUMN added_at TEXT;
      ALTER TABLE products ADD COLUMN verified INTEGER DEFAULT 0;
    `,
  },
  {
    version: 2,
    sql: `ALTER TABLE mp_rooms ADD COLUMN password TEXT;`,
  },
  {
    version: 3,
    sql: `
      CREATE INDEX IF NOT EXISTS idx_mp_players_room
        ON mp_players(room_code, is_kicked, connected);
      CREATE INDEX IF NOT EXISTS idx_mp_guesses_room_round
        ON mp_guesses(room_code, round_number);
      CREATE INDEX IF NOT EXISTS idx_products_active_category
        ON products(is_active, category, last_used_at);
      CREATE INDEX IF NOT EXISTS idx_mp_rooms_status_created
        ON mp_rooms(status, created_at);
    `,
  },
  {
    version: 4,
    sql: `ALTER TABLE products ADD COLUMN manufacturer TEXT;`,
  },
  {
    version: 5,
    sql: `
      CREATE TABLE IF NOT EXISTS admin_users (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_login_at TEXT,
        is_active INTEGER DEFAULT 1,
        failed_login_count INTEGER DEFAULT 0,
        locked_until TEXT
      );

      CREATE TABLE IF NOT EXISTS admin_sessions (
        id TEXT PRIMARY KEY,
        admin_user_id TEXT NOT NULL,
        ip_address TEXT,
        user_agent TEXT,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        last_active_at TEXT NOT NULL,
        FOREIGN KEY (admin_user_id) REFERENCES admin_users(id)
      );

      CREATE TABLE IF NOT EXISTS analytics_daily (
        date TEXT NOT NULL,
        game_type TEXT NOT NULL,
        game_mode TEXT NOT NULL,
        games_started INTEGER DEFAULT 0,
        games_completed INTEGER DEFAULT 0,
        total_players INTEGER DEFAULT 0,
        total_score_sum INTEGER DEFAULT 0,
        total_rounds_played INTEGER DEFAULT 0,
        PRIMARY KEY (date, game_type, game_mode)
      );

      CREATE TABLE IF NOT EXISTS analytics_daily_categories (
        date TEXT NOT NULL,
        category TEXT NOT NULL,
        rounds_played INTEGER DEFAULT 0,
        PRIMARY KEY (date, category)
      );

      CREATE INDEX IF NOT EXISTS idx_admin_sessions_expiry ON admin_sessions(expires_at);
      CREATE INDEX IF NOT EXISTS idx_admin_sessions_user ON admin_sessions(admin_user_id);
      CREATE INDEX IF NOT EXISTS idx_game_sessions_started_at ON game_sessions(started_at);
      CREATE INDEX IF NOT EXISTS idx_game_sessions_mode_completed ON game_sessions(game_mode, completed_at);
      CREATE INDEX IF NOT EXISTS idx_mp_rooms_created_at ON mp_rooms(created_at);
      CREATE INDEX IF NOT EXISTS idx_game_rounds_guessed_at ON game_rounds(guessed_at);
    `,
  },
  {
    version: 6,
    sql: `
      ALTER TABLE mp_rooms ADD COLUMN last_activity_at TEXT;
      -- Backfill: best approximation from existing data. Rooms in 'playing' state
      -- get created_at (no better timestamp available), which may cause the first
      -- cleanup cycle to delete long-running rooms created > 2h ago.
      UPDATE mp_rooms SET last_activity_at = COALESCE(finished_at, created_at);
      CREATE INDEX IF NOT EXISTS idx_mp_rooms_last_activity ON mp_rooms(last_activity_at);
    `,
  },
  {
    version: 7,
    sql: `
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL UNIQUE,
        username_normalized TEXT NOT NULL UNIQUE,
        email TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        email_verified INTEGER DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_login_at TEXT,
        is_active INTEGER DEFAULT 1,
        failed_login_count INTEGER DEFAULT 0,
        locked_until TEXT,
        lifetime_score INTEGER DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS user_sessions (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        ip_address TEXT,
        user_agent TEXT,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        last_active_at TEXT NOT NULL,
        FOREIGN KEY (user_id) REFERENCES users(id)
      );

      CREATE TABLE IF NOT EXISTS email_verification_tokens (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        token TEXT NOT NULL UNIQUE,
        email TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        used_at TEXT,
        FOREIGN KEY (user_id) REFERENCES users(id)
      );

      CREATE TABLE IF NOT EXISTS user_game_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL,
        game_type TEXT NOT NULL,
        game_mode TEXT NOT NULL,
        session_id TEXT,
        room_code TEXT,
        score INTEGER NOT NULL,
        placement INTEGER,
        players_count INTEGER,
        played_at TEXT NOT NULL,
        FOREIGN KEY (user_id) REFERENCES users(id)
      );

      CREATE TABLE IF NOT EXISTS user_rewards (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        reward_type TEXT NOT NULL,
        reward_data TEXT,
        status TEXT NOT NULL DEFAULT 'active',
        earned_at TEXT NOT NULL,
        redeemed_at TEXT,
        expires_at TEXT,
        FOREIGN KEY (user_id) REFERENCES users(id)
      );

      CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
      CREATE INDEX IF NOT EXISTS idx_users_username_normalized ON users(username_normalized);
      CREATE INDEX IF NOT EXISTS idx_user_sessions_user ON user_sessions(user_id);
      CREATE INDEX IF NOT EXISTS idx_user_sessions_expiry ON user_sessions(expires_at);
      CREATE INDEX IF NOT EXISTS idx_email_verification_token ON email_verification_tokens(token);
      CREATE INDEX IF NOT EXISTS idx_email_verification_user ON email_verification_tokens(user_id);
      CREATE INDEX IF NOT EXISTS idx_user_game_history_user ON user_game_history(user_id, played_at);
      CREATE INDEX IF NOT EXISTS idx_user_rewards_user ON user_rewards(user_id, status);
    `,
  },
  {
    version: 8,
    sql: `
      ALTER TABLE leaderboard ADD COLUMN user_id TEXT;
      ALTER TABLE mp_leaderboard ADD COLUMN user_id TEXT;
      ALTER TABLE mp_players ADD COLUMN user_id TEXT;
      ALTER TABLE game_sessions ADD COLUMN user_id TEXT;

      CREATE INDEX IF NOT EXISTS idx_leaderboard_user ON leaderboard(user_id);
      CREATE INDEX IF NOT EXISTS idx_mp_leaderboard_user ON mp_leaderboard(user_id);
    `,
  },
  {
    version: 9,
    sql: `
      ALTER TABLE users ADD COLUMN oauth_provider TEXT;
      ALTER TABLE users ADD COLUMN oauth_provider_id TEXT;
      CREATE INDEX IF NOT EXISTS idx_users_oauth ON users(oauth_provider, oauth_provider_id);
    `,
  },
  {
    version: 10,
    sql: `
      CREATE UNIQUE INDEX IF NOT EXISTS idx_user_game_history_session
        ON user_game_history(user_id, session_id)
        WHERE session_id IS NOT NULL;
    `,
  },
  {
    version: 11,
    sql: `
      CREATE TABLE IF NOT EXISTS user_product_views (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL,
        product_id INTEGER NOT NULL,
        session_id TEXT NOT NULL,
        seen_at TEXT NOT NULL,
        FOREIGN KEY (user_id) REFERENCES users(id),
        FOREIGN KEY (product_id) REFERENCES products(id)
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_upv_user_product_session
        ON user_product_views(user_id, product_id, session_id);
      CREATE INDEX IF NOT EXISTS idx_upv_user_seen ON user_product_views(user_id, seen_at DESC);
    `,
  },
  {
    version: 12,
    sql: `ALTER TABLE admin_users ADD COLUMN can_use_extension INTEGER DEFAULT 0;`,
  },
  {
    // NOTE: Migrations v13-v14 reference pu_sources(id) via FK, but pu_sources
    // is created in v16. SQLite ignores FK constraints unless PRAGMA foreign_keys
    // is ON at table-creation time. These migrations have already been applied in
    // production so they cannot be reordered; the dependency is safe in practice.
    version: 13,
    sql: `
      -- Product Universe: materials knowledge
      CREATE TABLE IF NOT EXISTS pu_materials (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        category TEXT,
        description TEXT,
        sustainability_score REAL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS pu_product_materials (
        product_id INTEGER NOT NULL,
        material_id INTEGER NOT NULL,
        percentage REAL,
        confidence TEXT NOT NULL DEFAULT 'medium',
        source_id INTEGER,
        PRIMARY KEY (product_id, material_id),
        FOREIGN KEY (product_id) REFERENCES products(id),
        FOREIGN KEY (material_id) REFERENCES pu_materials(id),
        FOREIGN KEY (source_id) REFERENCES pu_sources(id)
      );

      ALTER TABLE products ADD COLUMN pu_enriched INTEGER DEFAULT 0;
      ALTER TABLE products ADD COLUMN pu_enriched_at TEXT;
      ALTER TABLE products ADD COLUMN pu_summary TEXT;
      ALTER TABLE products ADD COLUMN pu_history TEXT;
    `,
  },
  {
    version: 14,
    sql: `
      -- Product Universe: companies, locations, supply chain
      CREATE TABLE IF NOT EXISTS pu_companies (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        description TEXT,
        website TEXT,
        logo_url TEXT,
        founded_year INTEGER,
        headquarters TEXT,
        employee_count INTEGER,
        revenue TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_pu_companies_name ON pu_companies(name);

      CREATE TABLE IF NOT EXISTS pu_locations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        country TEXT NOT NULL,
        region TEXT,
        latitude REAL,
        longitude REAL,
        location_type TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_pu_locations_country ON pu_locations(country);

      CREATE TABLE IF NOT EXISTS pu_supply_chain_nodes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        product_id INTEGER NOT NULL,
        node_type TEXT NOT NULL,
        company_id INTEGER,
        location_id INTEGER,
        description TEXT,
        order_index INTEGER NOT NULL DEFAULT 0,
        confidence TEXT NOT NULL DEFAULT 'medium',
        source_id INTEGER,
        FOREIGN KEY (product_id) REFERENCES products(id),
        FOREIGN KEY (company_id) REFERENCES pu_companies(id),
        FOREIGN KEY (location_id) REFERENCES pu_locations(id),
        FOREIGN KEY (source_id) REFERENCES pu_sources(id)
      );
      CREATE INDEX IF NOT EXISTS idx_pu_scn_product ON pu_supply_chain_nodes(product_id);

      CREATE TABLE IF NOT EXISTS pu_company_relationships (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        company_id INTEGER NOT NULL,
        related_company_id INTEGER NOT NULL,
        relationship_type TEXT NOT NULL,
        confidence TEXT NOT NULL DEFAULT 'medium',
        source_id INTEGER,
        FOREIGN KEY (company_id) REFERENCES pu_companies(id),
        FOREIGN KEY (related_company_id) REFERENCES pu_companies(id),
        FOREIGN KEY (source_id) REFERENCES pu_sources(id),
        UNIQUE(company_id, related_company_id, relationship_type)
      );

      CREATE TABLE IF NOT EXISTS pu_product_companies (
        product_id INTEGER NOT NULL,
        company_id INTEGER NOT NULL,
        role TEXT NOT NULL,
        confidence TEXT NOT NULL DEFAULT 'medium',
        source_id INTEGER,
        PRIMARY KEY (product_id, company_id, role),
        FOREIGN KEY (product_id) REFERENCES products(id),
        FOREIGN KEY (company_id) REFERENCES pu_companies(id),
        FOREIGN KEY (source_id) REFERENCES pu_sources(id)
      );
    `,
  },
  {
    version: 15,
    sql: `
      -- Product Universe: similarity + galaxy positions
      CREATE TABLE IF NOT EXISTS pu_product_similarity (
        product_id_a INTEGER NOT NULL,
        product_id_b INTEGER NOT NULL,
        score REAL NOT NULL,
        reason TEXT,
        PRIMARY KEY (product_id_a, product_id_b),
        FOREIGN KEY (product_id_a) REFERENCES products(id),
        FOREIGN KEY (product_id_b) REFERENCES products(id)
      );

      CREATE TABLE IF NOT EXISTS pu_galaxy_positions (
        product_id INTEGER PRIMARY KEY,
        x REAL NOT NULL,
        y REAL NOT NULL,
        z REAL NOT NULL,
        cluster INTEGER,
        FOREIGN KEY (product_id) REFERENCES products(id)
      );
    `,
  },
  {
    version: 16,
    sql: `
      -- Product Universe: data harvesting pipeline
      CREATE TABLE IF NOT EXISTS pu_sources (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        url TEXT NOT NULL,
        title TEXT,
        fetched_at TEXT NOT NULL DEFAULT (datetime('now')),
        content_hash TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_pu_sources_url ON pu_sources(url);

      CREATE TABLE IF NOT EXISTS pu_enrichment_jobs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        product_id INTEGER,
        company_id INTEGER,
        job_type TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        priority INTEGER NOT NULL DEFAULT 0,
        attempts INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        started_at TEXT,
        completed_at TEXT,
        FOREIGN KEY (product_id) REFERENCES products(id),
        FOREIGN KEY (company_id) REFERENCES pu_companies(id)
      );
      CREATE INDEX IF NOT EXISTS idx_pu_jobs_status ON pu_enrichment_jobs(status, priority DESC);
      CREATE INDEX IF NOT EXISTS idx_pu_jobs_product ON pu_enrichment_jobs(product_id);

      CREATE TABLE IF NOT EXISTS pu_search_cache (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        query TEXT NOT NULL UNIQUE,
        result_json TEXT NOT NULL,
        cached_at TEXT NOT NULL DEFAULT (datetime('now')),
        expires_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_pu_search_cache_query ON pu_search_cache(query);
      CREATE INDEX IF NOT EXISTS idx_pu_search_cache_expires ON pu_search_cache(expires_at);
    `,
  },
  {
    version: 17,
    sql: `
      -- Product Universe: material sourcing locations
      CREATE TABLE IF NOT EXISTS pu_material_locations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        material_id INTEGER NOT NULL,
        location_id INTEGER NOT NULL,
        role TEXT,
        confidence TEXT NOT NULL DEFAULT 'medium',
        source_id INTEGER,
        FOREIGN KEY (material_id) REFERENCES pu_materials(id),
        FOREIGN KEY (location_id) REFERENCES pu_locations(id),
        FOREIGN KEY (source_id) REFERENCES pu_sources(id),
        UNIQUE(material_id, location_id)
      );
    `,
  },
  {
    version: 18,
    sql: `
      -- Prevent double-submit: unique constraint on (session_id, round_number)
      CREATE UNIQUE INDEX IF NOT EXISTS idx_game_rounds_session_round
        ON game_rounds(session_id, round_number);
    `,
  },
  {
    version: 19,
    sql: `
      -- Enforce unique URLs in pu_sources (deduplicate any existing rows first)
      DELETE FROM pu_sources WHERE id NOT IN (
        SELECT MIN(id) FROM pu_sources GROUP BY url
      );
      DROP INDEX IF EXISTS idx_pu_sources_url;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_pu_sources_url ON pu_sources(url);
    `,
  },
  {
    version: 20,
    sql: `
      -- Rewards system: admin-managed reward pool and award tracking
      CREATE TABLE IF NOT EXISTS reward_pool (
        id TEXT PRIMARY KEY,
        reward_type TEXT NOT NULL DEFAULT 'amazon_gift_card',
        amount_cents INTEGER NOT NULL,
        code TEXT NOT NULL,
        description TEXT,
        status TEXT NOT NULL DEFAULT 'available',
        created_at TEXT NOT NULL,
        created_by TEXT NOT NULL,
        FOREIGN KEY (created_by) REFERENCES admin_users(id)
      );

      CREATE TABLE IF NOT EXISTS reward_awards (
        id TEXT PRIMARY KEY,
        reward_id TEXT NOT NULL UNIQUE,
        user_id TEXT NOT NULL,
        award_method TEXT NOT NULL,
        award_criteria TEXT,
        awarded_at TEXT NOT NULL,
        awarded_by TEXT NOT NULL,
        claimed_at TEXT,
        FOREIGN KEY (reward_id) REFERENCES reward_pool(id),
        FOREIGN KEY (user_id) REFERENCES users(id),
        FOREIGN KEY (awarded_by) REFERENCES admin_users(id)
      );

      CREATE INDEX IF NOT EXISTS idx_reward_pool_status ON reward_pool(status);
      CREATE INDEX IF NOT EXISTS idx_reward_awards_user ON reward_awards(user_id);
      -- Note: reward_awards.reward_id already has a UNIQUE constraint (implicit index)
    `,
  },
  {
    version: 21,
    sql: `
      -- Site-wide settings (key-value store for admin-configurable options)
      CREATE TABLE IF NOT EXISTS site_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      -- Seed default promo banner
      INSERT OR IGNORE INTO site_settings (key, value, updated_at)
      VALUES (
        'promo_banner',
        '{"enabled":true,"text":"Score 20,000+ points for a chance to win a $20 Amazon Gift Card!","linkText":"Learn More","linkUrl":"/settings","audienceMode":"logged_in","showLink":true}',
        datetime('now')
      );
    `,
  },
  {
    version: 22,
    sql: `
      -- Enforce unique gift card codes to prevent double-awarding
      CREATE UNIQUE INDEX IF NOT EXISTS idx_reward_pool_code ON reward_pool(code);
    `,
  },
  {
    version: 23,
    sql: `
      CREATE TABLE IF NOT EXISTS password_reset_tokens (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        token TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        used_at TEXT,
        FOREIGN KEY (user_id) REFERENCES users(id)
      );
      CREATE INDEX IF NOT EXISTS idx_password_reset_token ON password_reset_tokens(token);
      CREATE INDEX IF NOT EXISTS idx_password_reset_user ON password_reset_tokens(user_id);
    `,
  },
  {
    version: 24,
    sql: `ALTER TABLE users ADD COLUMN username_pending INTEGER DEFAULT 0;`,
  },
  {
    version: 25,
    sql: `SELECT 1;`, // Legal documents are seeded programmatically below
  },
  {
    version: 26,
    sql: `
      ALTER TABLE products ADD COLUMN is_archived INTEGER DEFAULT 0;
      CREATE INDEX IF NOT EXISTS idx_products_archived ON products(is_archived);
    `,
  },
  {
    version: 27,
    sql: `
      ALTER TABLE users ADD COLUMN referral_code TEXT;

      CREATE TABLE IF NOT EXISTS referrals (
        id TEXT PRIMARY KEY,
        referrer_id TEXT NOT NULL,
        referred_id TEXT NOT NULL UNIQUE,
        referral_code TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        rejection_reason TEXT,
        referrer_ip TEXT,
        referred_ip TEXT,
        created_at TEXT NOT NULL,
        credited_at TEXT,
        FOREIGN KEY (referrer_id) REFERENCES users(id),
        FOREIGN KEY (referred_id) REFERENCES users(id)
      );

      CREATE INDEX IF NOT EXISTS idx_referrals_referrer ON referrals(referrer_id);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_users_referral_code ON users(referral_code);
    `,
  },
  {
    version: 28,
    sql: `
      ALTER TABLE users ADD COLUMN utm_source TEXT;
      ALTER TABLE users ADD COLUMN utm_medium TEXT;
      ALTER TABLE users ADD COLUMN utm_campaign TEXT;
      ALTER TABLE users ADD COLUMN utm_content TEXT;
      ALTER TABLE users ADD COLUMN utm_term TEXT;
      ALTER TABLE users ADD COLUMN landing_page TEXT;
      ALTER TABLE users ADD COLUMN signup_referrer TEXT;
    `,
  },
  {
    version: 29,
    sql: `
      CREATE TABLE IF NOT EXISTS utm_tags (
        id              TEXT PRIMARY KEY,
        name            TEXT NOT NULL UNIQUE,
        utm_source      TEXT NOT NULL,
        utm_medium      TEXT,
        utm_campaign    TEXT,
        utm_content     TEXT,
        utm_term        TEXT,
        destination_url TEXT NOT NULL,
        status          TEXT NOT NULL DEFAULT 'active'
                        CHECK(status IN ('active', 'archived')),
        created_at      TEXT NOT NULL,
        updated_at      TEXT NOT NULL,
        created_by      TEXT,
        FOREIGN KEY (created_by) REFERENCES admin_users(id)
      );

      CREATE INDEX IF NOT EXISTS idx_utm_tags_status ON utm_tags(status);
      CREATE INDEX IF NOT EXISTS idx_utm_tags_source_campaign
        ON utm_tags(utm_source, utm_campaign);

      CREATE INDEX IF NOT EXISTS idx_users_utm_cohort
        ON users(utm_source, utm_medium, utm_campaign);
    `,
  },
  {
    version: 30,
    sql: `
      -- Short-link redirect service + lightweight click counter on utm_tags.
      -- Clicks are stored as a single counter + timestamp on the tag row — no
      -- per-click rows, no PII (no IP / user agent / referer).
      ALTER TABLE utm_tags ADD COLUMN short_code TEXT;
      ALTER TABLE utm_tags ADD COLUMN click_count INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE utm_tags ADD COLUMN last_clicked_at TEXT;

      -- Partial unique index: allow multiple NULLs, enforce uniqueness among
      -- set codes. The redirect handler uses this index for O(log n) lookup.
      CREATE UNIQUE INDEX IF NOT EXISTS idx_utm_tags_short_code
        ON utm_tags(short_code)
        WHERE short_code IS NOT NULL;
    `,
  },
  {
    version: 31,
    sql: `
      -- Anonymous visitor attribution: ties UTM source and pre-signup game
      -- plays to a visitor_id cookie, independent of user registration.
      -- On signup, the row is claimed by setting claimed_user_id and its
      -- UTM fields are merged into the users row (first-touch wins).
      CREATE TABLE IF NOT EXISTS visitor_attribution (
        visitor_id       TEXT PRIMARY KEY,
        utm_source       TEXT NOT NULL,
        utm_medium       TEXT,
        utm_campaign     TEXT,
        utm_content      TEXT,
        utm_term         TEXT,
        landing_page     TEXT,
        referrer         TEXT,
        first_seen_at    TEXT NOT NULL,
        first_game_at    TEXT,
        first_game_type  TEXT,
        first_game_mode  TEXT,
        games_played     INTEGER NOT NULL DEFAULT 0,
        claimed_user_id  TEXT,
        claimed_at       TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_visitor_attribution_utm
        ON visitor_attribution(utm_source, utm_medium, utm_campaign);
      CREATE INDEX IF NOT EXISTS idx_visitor_attribution_claimed
        ON visitor_attribution(claimed_user_id);

      -- Link mp_players rows to a visitor_id so mpRoundEnd can credit
      -- anonymous games to a visitor at end-of-game time.
      ALTER TABLE mp_players ADD COLUMN visitor_id TEXT;
    `,
  },
  {
    version: 32,
    sql: `
      -- Daily challenge mode (Wordle-style shared puzzle).
      CREATE TABLE IF NOT EXISTS daily_puzzles (
        daily_date          TEXT PRIMARY KEY,
        game_mode           TEXT NOT NULL,
        product_ids         TEXT NOT NULL,
        round_data          TEXT,
        salt_version        INTEGER NOT NULL DEFAULT 1,
        is_manual_override  INTEGER NOT NULL DEFAULT 0,
        created_at          TEXT NOT NULL,
        updated_at          TEXT
      );

      CREATE TABLE IF NOT EXISTS daily_plays (
        id                    INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id               TEXT,
        session_id            TEXT NOT NULL UNIQUE,
        daily_date            TEXT NOT NULL,
        game_mode             TEXT NOT NULL,
        score                 INTEGER NOT NULL DEFAULT 0,
        per_round_scores      TEXT,
        streak_at_completion  INTEGER,
        started_at            TEXT NOT NULL,
        completed_at          TEXT,
        FOREIGN KEY (user_id) REFERENCES users(id)
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_daily_plays_user_date
        ON daily_plays(user_id, daily_date)
        WHERE user_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_daily_plays_date ON daily_plays(daily_date);

      ALTER TABLE users ADD COLUMN daily_streak_current   INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE users ADD COLUMN daily_streak_best      INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE users ADD COLUMN daily_streak_last_date TEXT;

      ALTER TABLE game_sessions ADD COLUMN is_daily   INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE game_sessions ADD COLUMN daily_date TEXT;
    `,
  },
  {
    version: 33,
    sql: `
      -- Per-session round count for single-player games. Lets users pick from
      -- the Game Options menu (3, 5, or 10). NULL on legacy rows is treated
      -- as DEFAULT_TOTAL_ROUNDS by getSessionTotalRounds().
      ALTER TABLE game_sessions ADD COLUMN total_rounds INTEGER;
    `,
  },
  {
    version: 34,
    sql: `
      -- Index for leaderboard v2 queries that rank by lifetime_score.
      CREATE INDEX IF NOT EXISTS idx_users_lifetime_score
        ON users(lifetime_score DESC);
    `,
  },
  {
    version: 35,
    sql: `
      -- Push subscription storage (one user can have multiple devices/browsers)
      CREATE TABLE IF NOT EXISTS push_subscriptions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL,
        endpoint TEXT NOT NULL UNIQUE,
        p256dh TEXT NOT NULL,
        auth TEXT NOT NULL,
        expiration_time INTEGER,
        user_agent TEXT,
        is_active INTEGER DEFAULT 1,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now')),
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_push_subs_user ON push_subscriptions(user_id);
      CREATE INDEX IF NOT EXISTS idx_push_subs_active ON push_subscriptions(is_active, user_id);

      -- Per-user notification preferences (one row per user)
      CREATE TABLE IF NOT EXISTS notification_preferences (
        user_id TEXT PRIMARY KEY,
        push_enabled INTEGER DEFAULT 1,
        daily_puzzle INTEGER DEFAULT 1,
        streak_reminder INTEGER DEFAULT 1,
        leaderboard_updates INTEGER DEFAULT 0,
        multiplayer_invites INTEGER DEFAULT 1,
        promotional INTEGER DEFAULT 0,
        quiet_hours_start TEXT,
        quiet_hours_end TEXT,
        timezone TEXT DEFAULT 'UTC',
        updated_at TEXT DEFAULT (datetime('now')),
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      );

      -- Admin-managed notification templates
      CREATE TABLE IF NOT EXISTS notification_templates (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        type TEXT NOT NULL,
        title_template TEXT NOT NULL,
        body_template TEXT NOT NULL,
        icon TEXT DEFAULT '/logo192.png',
        url_path TEXT DEFAULT '/',
        actions_json TEXT,
        ttl INTEGER DEFAULT 3600,
        urgency TEXT DEFAULT 'normal',
        is_active INTEGER DEFAULT 1,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      );

      -- Notification send log (analytics + click tracking)
      CREATE TABLE IF NOT EXISTS notification_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL,
        subscription_id INTEGER,
        template_id INTEGER,
        type TEXT NOT NULL,
        title TEXT,
        body TEXT,
        url_path TEXT,
        status TEXT DEFAULT 'pending',
        http_status INTEGER,
        error_message TEXT,
        sent_at TEXT,
        clicked_at TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_notif_log_user ON notification_log(user_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_notif_log_type_status ON notification_log(type, status);

      -- Scheduled notification queue (processed by the scheduler loop)
      CREATE TABLE IF NOT EXISTS scheduled_notifications (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL,
        template_id INTEGER,
        type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        scheduled_at TEXT NOT NULL,
        status TEXT DEFAULT 'pending',
        attempts INTEGER DEFAULT 0,
        sent_at TEXT,
        error_message TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_sched_notif_due ON scheduled_notifications(status, scheduled_at);
    `,
  },
  {
    version: 36,
    sql: `
      -- Admin 2FA: new columns on admin_users
      ALTER TABLE admin_users ADD COLUMN totp_secret_encrypted TEXT;
      ALTER TABLE admin_users ADD COLUMN totp_enabled INTEGER DEFAULT 0;
      ALTER TABLE admin_users ADD COLUMN totp_verified_at TEXT;
      ALTER TABLE admin_users ADD COLUMN totp_last_used_counter INTEGER;

      -- Admin 2FA: recovery codes (hashed, one-time use)
      CREATE TABLE IF NOT EXISTS admin_2fa_recovery_codes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        admin_user_id TEXT NOT NULL,
        code_hash TEXT NOT NULL,
        salt TEXT NOT NULL,
        is_used INTEGER DEFAULT 0,
        used_at TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY (admin_user_id) REFERENCES admin_users(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_admin_2fa_recovery_user
        ON admin_2fa_recovery_codes(admin_user_id, is_used);

      -- Admin 2FA: pending login tokens (short-lived, hashed at rest)
      CREATE TABLE IF NOT EXISTS admin_2fa_pending (
        id TEXT PRIMARY KEY,
        token_hash TEXT NOT NULL,
        admin_user_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        ip_address TEXT,
        user_agent TEXT,
        FOREIGN KEY (admin_user_id) REFERENCES admin_users(id) ON DELETE CASCADE
      );

      -- Admin 2FA: audit log
      CREATE TABLE IF NOT EXISTS admin_2fa_audit_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        admin_user_id TEXT NOT NULL,
        event TEXT NOT NULL,
        ip_address TEXT,
        user_agent TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY (admin_user_id) REFERENCES admin_users(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_admin_2fa_audit_user
        ON admin_2fa_audit_log(admin_user_id, created_at);
    `,
  },
  {
    version: 37,
    sql: `ALTER TABLE users ADD COLUMN avatar TEXT;`,
  },
  {
    version: 38,
    sql: `
      -- Bots: flag on mp_players
      ALTER TABLE mp_players ADD COLUMN is_bot INTEGER DEFAULT 0;

      -- Public lobbies and bot config on mp_rooms
      ALTER TABLE mp_rooms ADD COLUMN is_public INTEGER DEFAULT 0;
      ALTER TABLE mp_rooms ADD COLUMN bot_count INTEGER DEFAULT 0;
      ALTER TABLE mp_rooms ADD COLUMN bot_difficulty TEXT DEFAULT 'medium';

      -- Index for public lobby listing
      CREATE INDEX IF NOT EXISTS idx_mp_rooms_public_lobby
        ON mp_rooms(is_public, status);
    `,
  },
  {
    version: 39,
    sql: `
      -- Best-ever leaderboard rank (lowest number = best)
      ALTER TABLE users ADD COLUMN best_rank INTEGER;

      -- Rank history: one row per game completion for the rank-over-time chart
      CREATE TABLE IF NOT EXISTS user_rank_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL,
        rank INTEGER NOT NULL,
        total_players INTEGER NOT NULL,
        recorded_at TEXT NOT NULL,
        FOREIGN KEY (user_id) REFERENCES users(id)
      );
      CREATE INDEX IF NOT EXISTS idx_user_rank_history_user
        ON user_rank_history(user_id, recorded_at);
    `,
  },
  {
    version: 40,
    sql: `
      -- Device-aware notifications (fix for bogus daily_puzzle reminders when a
      -- logged-out account plays daily as a guest). Thread visitor_id (the
      -- persistent per-browser cookie from visitorCookie middleware) through
      -- push_subscriptions, daily_plays, and game_sessions so the notification
      -- scheduler can filter on EITHER the linked user or the linked device.
      ALTER TABLE push_subscriptions ADD COLUMN visitor_id TEXT;
      CREATE INDEX IF NOT EXISTS idx_push_subs_visitor
        ON push_subscriptions(visitor_id) WHERE visitor_id IS NOT NULL;

      -- visitor_id on daily_plays lets the scheduler check "did this device
      -- play today?" independent of whether the play was logged-in or guest.
      -- UNIQUE on (visitor_id, daily_date) prevents guest double-plays from
      -- the same device, mirroring the existing (user_id, daily_date) index.
      ALTER TABLE daily_plays ADD COLUMN visitor_id TEXT;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_daily_plays_visitor_date
        ON daily_plays(visitor_id, daily_date) WHERE visitor_id IS NOT NULL;

      -- Persist visitor_id on the session so submitGuess can copy it onto
      -- daily_plays without threading a new parameter through the call chain.
      ALTER TABLE game_sessions ADD COLUMN visitor_id TEXT;
    `,
  },
  {
    version: 41,
    sql: `
      ALTER TABLE user_game_history ADD COLUMN share_id TEXT;
    `,
  },
  {
    version: 42,
    sql: `
      -- Email notification system (parallel to push, coarser cadence, opt-in).
      -- Separate tables from push: email triggers, cooldowns, and preferences
      -- are fundamentally different from push so sharing schema would force
      -- one cadence on the other.

      -- Per-user email preferences. Every boolean defaults to 0 (opt-in).
      CREATE TABLE IF NOT EXISTS email_preferences (
        user_id TEXT PRIMARY KEY,
        email_enabled INTEGER DEFAULT 0,
        streak_risk INTEGER DEFAULT 0,
        streak_save INTEGER DEFAULT 0,
        inactivity_reminder INTEGER DEFAULT 0,
        weekly_digest INTEGER DEFAULT 0,
        promotional INTEGER DEFAULT 0,
        preferred_hour INTEGER DEFAULT 10,
        timezone TEXT DEFAULT 'UTC',
        updated_at TEXT DEFAULT (datetime('now')),
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      );

      -- Admin-managed email templates. Separate from notification_templates
      -- because email has subject + HTML + optional text vs push's
      -- title + body + icon + url.
      CREATE TABLE IF NOT EXISTS email_templates (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        type TEXT NOT NULL,
        subject_template TEXT NOT NULL,
        html_template TEXT NOT NULL,
        text_template TEXT,
        is_active INTEGER DEFAULT 1,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      );

      -- Email delivery log. to_address captured at send time in case the
      -- user later changes their email — we still want a correct record.
      CREATE TABLE IF NOT EXISTS email_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT,
        template_id INTEGER,
        type TEXT NOT NULL,
        to_address TEXT NOT NULL,
        subject TEXT,
        status TEXT NOT NULL DEFAULT 'queued',
        provider_message_id TEXT,
        error_message TEXT,
        sent_at TEXT,
        opened_at TEXT,
        clicked_at TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
        FOREIGN KEY (template_id) REFERENCES email_templates(id) ON DELETE SET NULL
      );
      CREATE INDEX IF NOT EXISTS idx_email_log_user_type
        ON email_log(user_id, type, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_email_log_status
        ON email_log(status, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_email_log_provider_id
        ON email_log(provider_message_id) WHERE provider_message_id IS NOT NULL;

      -- Delayed-send queue. Coarser cadence than push means most sends are
      -- enqueued for the user's preferred_hour in their local timezone.
      CREATE TABLE IF NOT EXISTS scheduled_emails (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL,
        template_id INTEGER,
        type TEXT NOT NULL,
        vars_json TEXT,
        scheduled_at TEXT NOT NULL,
        status TEXT DEFAULT 'pending',
        attempts INTEGER DEFAULT 0,
        sent_at TEXT,
        error_message TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
        FOREIGN KEY (template_id) REFERENCES email_templates(id) ON DELETE SET NULL
      );
      CREATE INDEX IF NOT EXISTS idx_sched_email_due
        ON scheduled_emails(status, scheduled_at);

      -- Admin-tunable trigger config: one row per trigger type. Defaults
      -- are inserted below so the admin UI opens populated.
      CREATE TABLE IF NOT EXISTS email_trigger_config (
        type TEXT PRIMARY KEY,
        is_enabled INTEGER DEFAULT 0,
        cooldown_hours INTEGER NOT NULL,
        threshold_json TEXT,
        template_id INTEGER,
        updated_at TEXT DEFAULT (datetime('now')),
        FOREIGN KEY (template_id) REFERENCES email_templates(id) ON DELETE SET NULL
      );

      -- Audit trail for unsubscribe events. The actual opt-out state lives
      -- on email_preferences; this table is an append-only record for
      -- compliance and debugging.
      CREATE TABLE IF NOT EXISTS email_unsubscribes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT,
        type TEXT,
        source TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_email_unsub_user
        ON email_unsubscribes(user_id, created_at DESC);

      -- Seed trigger config with sensible defaults. Everything is_enabled=0
      -- initially: admin must explicitly turn on each trigger.
      INSERT OR IGNORE INTO email_trigger_config (type, is_enabled, cooldown_hours, threshold_json)
        VALUES
          ('streak_risk',         0, 72,  '{"streakMin":3}'),
          ('streak_save',         0, 168, '{"streakMin":7}'),
          ('inactivity_reminder', 0, 336, '{"days":7}'),
          ('weekly_digest',       0, 144, '{"weekday":1,"hour":10}'),
          ('promotional',         0, 720, NULL);
    `,
  },
  {
    // Analytics expansion (Phase 1): unified first-party event stream, session
    // model, visitor rollup, and cross-device alias table. All tables live in
    // the main DB rather than an attached events.db so tests and migrations
    // stay simple; if event volume ever outgrows this we can split later by
    // copying rows into a secondary file and updating the `analyticsDb`
    // accessor. See docs/ANALYTICS.md for the rationale.
    version: 43,
    sql: `
      -- Append-only event log. Minimal FKs (cross-service references are
      -- tracked by column but not enforced) so that deleting upstream rows
      -- never stalls this write path.
      CREATE TABLE IF NOT EXISTS events (
        id                INTEGER PRIMARY KEY,
        ts_server         INTEGER NOT NULL,
        ts_client         INTEGER,
        visitor_id        TEXT NOT NULL,
        user_id           TEXT,
        session_id        TEXT NOT NULL,
        event_type        TEXT NOT NULL,
        event_name        TEXT NOT NULL,
        path              TEXT,
        referrer          TEXT,
        game_mode         TEXT,
        game_session_id   TEXT,
        mp_room_code      TEXT,
        properties        TEXT,
        country           TEXT,
        region            TEXT,
        browser           TEXT,
        os                TEXT,
        device_type       TEXT NOT NULL DEFAULT 'unknown',
        ua_hash           TEXT,
        ip_hash           TEXT,
        ip_salt_version   INTEGER NOT NULL DEFAULT 1,
        is_bot            INTEGER NOT NULL DEFAULT 0,
        client_event_id   TEXT,
        tab_id            TEXT,
        seq               INTEGER,
        dnt               INTEGER NOT NULL DEFAULT 0
      );

      CREATE INDEX IF NOT EXISTS idx_events_visitor_ts    ON events(visitor_id, ts_server);
      CREATE INDEX IF NOT EXISTS idx_events_user_ts       ON events(user_id, ts_server)
        WHERE user_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_events_name_ts       ON events(event_name, ts_server);
      CREATE INDEX IF NOT EXISTS idx_events_session_ts    ON events(session_id, ts_server);
      CREATE INDEX IF NOT EXISTS idx_events_game_session  ON events(game_session_id)
        WHERE game_session_id IS NOT NULL;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_events_dedupe ON events(visitor_id, client_event_id)
        WHERE client_event_id IS NOT NULL;

      -- Bounded session = sequence of events from one visitor with idle gap
      -- <30min (extended to 4h if a game is in progress). ended_at is set by
      -- the closeout sweep; nullable while active.
      CREATE TABLE IF NOT EXISTS analytics_sessions (
        id                 TEXT PRIMARY KEY,
        visitor_id         TEXT NOT NULL,
        user_id            TEXT,
        started_at         INTEGER NOT NULL,
        last_event_at      INTEGER NOT NULL,
        ended_at           INTEGER,
        event_count        INTEGER NOT NULL DEFAULT 1,
        page_view_count    INTEGER NOT NULL DEFAULT 0,
        games_started      INTEGER NOT NULL DEFAULT 0,
        games_completed    INTEGER NOT NULL DEFAULT 0,
        signup_occurred    INTEGER NOT NULL DEFAULT 0,
        login_occurred     INTEGER NOT NULL DEFAULT 0,
        entry_path         TEXT,
        entry_referrer     TEXT,
        entry_utm_source   TEXT,
        entry_utm_medium   TEXT,
        entry_utm_campaign TEXT,
        last_utm_source    TEXT,
        exit_path          TEXT,
        country            TEXT,
        browser            TEXT,
        os                 TEXT,
        device_type        TEXT NOT NULL DEFAULT 'unknown',
        is_returning       INTEGER NOT NULL DEFAULT 0,
        bounced            INTEGER,
        is_bot             INTEGER NOT NULL DEFAULT 0
      );

      CREATE INDEX IF NOT EXISTS idx_asessions_visitor  ON analytics_sessions(visitor_id, started_at);
      CREATE INDEX IF NOT EXISTS idx_asessions_user     ON analytics_sessions(user_id, started_at)
        WHERE user_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_asessions_started  ON analytics_sessions(started_at);
      CREATE INDEX IF NOT EXISTS idx_asessions_open     ON analytics_sessions(ended_at)
        WHERE ended_at IS NULL;

      -- One row per visitor (visitor_id). current_session_* double as the
      -- concurrency serialization point for new-session assignment: an
      -- UPSERT against visitor_profile atomically decides whether to mint a
      -- new session or reuse the current one.
      --
      -- Note: first-touch UTM is NOT stored here. It lives on
      -- visitor_attribution (visitor_id PK, migration v31) which already
      -- enforces first-touch-wins via INSERT OR IGNORE. Queries that need
      -- UTM for a visitor LEFT JOIN visitor_attribution; this keeps a
      -- single source of truth and preserves the existing attribution
      -- pipeline (recordVisitorAttribution, claimVisitorAttribution,
      -- mergeVisitorAttributionIntoUser).
      CREATE TABLE IF NOT EXISTS visitor_profile (
        visitor_id                TEXT PRIMARY KEY,
        user_id                   TEXT,
        first_seen_at             INTEGER NOT NULL,
        last_seen_at              INTEGER NOT NULL,
        current_session_id        TEXT,
        current_session_started   INTEGER,
        total_sessions            INTEGER NOT NULL DEFAULT 0,
        total_events              INTEGER NOT NULL DEFAULT 0,
        total_page_views          INTEGER NOT NULL DEFAULT 0,
        total_games_started       INTEGER NOT NULL DEFAULT 0,
        total_games_completed     INTEGER NOT NULL DEFAULT 0,
        total_time_ms             INTEGER NOT NULL DEFAULT 0,
        ever_registered           INTEGER NOT NULL DEFAULT 0,
        ever_played               INTEGER NOT NULL DEFAULT 0,
        last_session_bounced      INTEGER,
        first_country             TEXT,
        first_device_type         TEXT,
        is_bot                    INTEGER NOT NULL DEFAULT 0
      );

      CREATE INDEX IF NOT EXISTS idx_visitor_profile_user      ON visitor_profile(user_id)
        WHERE user_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_visitor_profile_last_seen ON visitor_profile(last_seen_at);

      -- Cross-device identity merge. Rows are written at user-login time so
      -- logged-in analytics can GROUP BY user_id and pick up activity from
      -- any device that user signed in on.
      CREATE TABLE IF NOT EXISTS visitor_aliases (
        visitor_id  TEXT NOT NULL,
        user_id     TEXT NOT NULL,
        merged_at   INTEGER NOT NULL,
        PRIMARY KEY (visitor_id, user_id)
      );

      CREATE INDEX IF NOT EXISTS idx_aliases_user ON visitor_aliases(user_id);

      -- Hourly pre-aggregation; drives all timeseries dashboards so queries
      -- never full-scan the events table. Rebuilt for the last 48h by a
      -- background job (every 10 min) to absorb late-arriving events.
      CREATE TABLE IF NOT EXISTS analytics_hourly (
        hour_bucket       INTEGER NOT NULL,
        device_type       TEXT NOT NULL,
        is_logged_in      INTEGER NOT NULL,
        country           TEXT NOT NULL DEFAULT 'unknown',
        acquisition_source TEXT NOT NULL DEFAULT 'unknown',
        sessions          INTEGER NOT NULL DEFAULT 0,
        new_sessions      INTEGER NOT NULL DEFAULT 0,
        bounced_sessions  INTEGER NOT NULL DEFAULT 0,
        events_count      INTEGER NOT NULL DEFAULT 0,
        page_views        INTEGER NOT NULL DEFAULT 0,
        games_started     INTEGER NOT NULL DEFAULT 0,
        games_completed   INTEGER NOT NULL DEFAULT 0,
        signups           INTEGER NOT NULL DEFAULT 0,
        logins            INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (hour_bucket, device_type, is_logged_in, country, acquisition_source)
      );

      CREATE INDEX IF NOT EXISTS idx_analytics_hourly_bucket ON analytics_hourly(hour_bucket);

      -- User-level rollup additions. Populated lazily: total_sessions bumps
      -- every time a session row is closed with user_id set; last_session_at
      -- is updated on each event with user_id.
      ALTER TABLE users ADD COLUMN total_sessions INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE users ADD COLUMN last_session_at INTEGER;
      ALTER TABLE users ADD COLUMN signup_session_id TEXT;
      ALTER TABLE users ADD COLUMN primary_device_type TEXT;
      ALTER TABLE users ADD COLUMN primary_country TEXT;
    `,
  },
  {
    version: 45,
    sql: `
      -- Daily-challenge multiplayer routing. When the daily mode is Bidding
      -- War, the daily card funnels players into an MP room via quickplay
      -- instead of the solo ClosestPage flow. Rooms carry the daily context
      -- so product selection pulls from daily_puzzles and game end writes
      -- to daily_plays + bumps the streak.
      ALTER TABLE mp_rooms ADD COLUMN is_daily_game INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE mp_rooms ADD COLUMN daily_date TEXT;

      -- Quickplay matchmaking filters daily rooms to same-date peers only;
      -- the partial index keeps the lookup cheap without bloating the
      -- regular-MP hot path.
      CREATE INDEX IF NOT EXISTS idx_mp_rooms_daily_lobby
        ON mp_rooms(daily_date, status)
        WHERE is_daily_game = 1;
    `,
  },
  {
    // Leaderboard placement notifications — push + email when a user enters
    // the top 3 of a daily / weekly / monthly leaderboard. New preference
    // columns default push to on (matches existing engagement push defaults)
    // and email to off (email is strictly opt-in).
    //
    // The tracking table prevents repeat sends: each row records the best
    // rank already announced to a user for a given (period, period_key)
    // bucket. A subsequent tick only re-notifies if the user's current rank
    // is strictly better than the last-notified rank.
    version: 46,
    sql: `
      ALTER TABLE notification_preferences
        ADD COLUMN leaderboard_placement INTEGER DEFAULT 1;

      ALTER TABLE email_preferences
        ADD COLUMN leaderboard_placement INTEGER DEFAULT 0;

      CREATE TABLE IF NOT EXISTS leaderboard_placement_notifications (
        user_id           TEXT NOT NULL,
        period            TEXT NOT NULL,        -- 'day' | 'week' | 'month'
        period_key        TEXT NOT NULL,        -- 'YYYY-MM-DD' | 'YYYY-Www' | 'YYYY-MM'
        best_rank         INTEGER NOT NULL,     -- lowest (best) rank already notified
        channel           TEXT NOT NULL DEFAULT 'any', -- reserved for future per-channel dedupe
        last_notified_at  TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (user_id, period, period_key),
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_leaderboard_placement_period
        ON leaderboard_placement_notifications(period, period_key);

      -- Seed the email trigger config so the admin panel can toggle it on
      -- and the email scheduler evaluator can discover it.
      INSERT OR IGNORE INTO email_trigger_config
        (type, is_enabled, cooldown_hours, threshold_json)
        VALUES
          ('leaderboard_placement', 0, 1, '{"topN":3}');

      -- Seed a default email template. Admins can edit it at runtime.
      INSERT OR IGNORE INTO email_templates
        (name, type, subject_template, html_template, text_template, is_active)
        VALUES
          (
            'Leaderboard placement',
            'leaderboard_placement',
            'You''re #{{rank}} on the {{periodLabel}} leaderboard!',
            '<h2 style="color:#f6c90e;margin:0 0 12px;">Nice work, {{username}}! 🏆</h2>' ||
              '<p>You''re currently <strong>#{{rank}}</strong> on the ' ||
              '<strong>{{periodLabel}}</strong> leaderboard.</p>' ||
              '<p>Can you climb higher before the period ends? ' ||
              '<a href="https://price.games/leaderboard" style="color:#54a24b;">See the leaderboard</a>.</p>',
            'Hi {{username}} — you''re currently #{{rank}} on the {{periodLabel}} leaderboard on price.games. Keep playing to climb higher!',
            1
          );
    `,
  },
  {
    // Suppression audit on notification_log. The scheduler now writes a log
    // row not only for sent / failed pushes but also for suppressed ones
    // (e.g., the user already played today, or the streak it was meant to
    // protect has already broken between scheduling and dispatch). The
    // 'suppressed' status + a free-form reason gives the admin notification
    // log a complete trail of "what we tried to send and why we didn't."
    version: 47,
    sql: `
      ALTER TABLE notification_log ADD COLUMN suppression_reason TEXT;
    `,
  },
  {
    // Add a default-on `giveaway_loss` opt-in to email_preferences and seed
    // a matching trigger config row. Default = 1 because the consolation
    // email is a transactional follow-up to a giveaway the user already
    // entered by playing — surprise opt-in here is the right behavior, and
    // users can still flip it off in settings or via one-click unsubscribe.
    version: 48,
    sql: `
      ALTER TABLE email_preferences ADD COLUMN giveaway_loss INTEGER NOT NULL DEFAULT 1;

      INSERT OR IGNORE INTO email_trigger_config (type, is_enabled, cooldown_hours, threshold_json)
        VALUES ('giveaway_loss', 1, 0, NULL);
    `,
  },
  {
    // Auto-lobby system. Columns mark rooms spawned by the AutoLobbyManager
    // and per-bot disguise (presented to clients as if human). The countdown
    // columns track the pre-game timer that starts when the first real human
    // joins an auto-lobby. The partial index speeds the manager's "how many
    // joinable auto-lobbies exist right now?" query without bloating the
    // hot path of normal multiplayer rooms.
    version: 49,
    sql: `
      ALTER TABLE mp_rooms ADD COLUMN is_auto_lobby INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE mp_rooms ADD COLUMN countdown_started_at TEXT;
      ALTER TABLE mp_rooms ADD COLUMN countdown_target_at TEXT;

      ALTER TABLE mp_players ADD COLUMN is_disguised INTEGER NOT NULL DEFAULT 0;

      CREATE INDEX IF NOT EXISTS idx_mp_rooms_auto_lobby
        ON mp_rooms(is_auto_lobby, status)
        WHERE is_auto_lobby = 1;
    `,
  },
  {
    // Admin leaderboard management. Adds soft-exclude markers on
    // leaderboard rows, account-level ban + test-account flags on users,
    // and an append-only audit log of admin moderation actions. Public
    // leaderboard read paths filter on these columns; the admin panel
    // writes them.
    version: 50,
    sql: `
      ALTER TABLE leaderboard ADD COLUMN excluded_at TEXT;
      ALTER TABLE leaderboard ADD COLUMN excluded_by_admin_id TEXT;
      ALTER TABLE leaderboard ADD COLUMN excluded_reason TEXT;

      ALTER TABLE users ADD COLUMN leaderboard_banned_at TEXT;
      ALTER TABLE users ADD COLUMN leaderboard_banned_until TEXT;
      ALTER TABLE users ADD COLUMN leaderboard_banned_reason TEXT;
      ALTER TABLE users ADD COLUMN leaderboard_banned_by TEXT;
      ALTER TABLE users ADD COLUMN is_test_account INTEGER NOT NULL DEFAULT 0;

      CREATE INDEX IF NOT EXISTS idx_leaderboard_excluded
        ON leaderboard(excluded_at);
      CREATE INDEX IF NOT EXISTS idx_users_lb_banned
        ON users(leaderboard_banned_at);

      CREATE TABLE IF NOT EXISTS admin_leaderboard_audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        admin_user_id TEXT NOT NULL,
        admin_username TEXT NOT NULL,
        action TEXT NOT NULL,
        target_type TEXT NOT NULL,
        target_id TEXT NOT NULL,
        target_label TEXT,
        reason TEXT,
        details_json TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY (admin_user_id) REFERENCES admin_users(id)
      );
      CREATE INDEX IF NOT EXISTS idx_admin_lb_audit_created
        ON admin_leaderboard_audit(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_admin_lb_audit_target
        ON admin_leaderboard_audit(target_type, target_id);
    `,
  },
  {
    // Ghost users — persistent synthetic player accounts that seat
    // auto-lobbies, accrue scores, and (in PR B) appear on the leaderboard
    // with full profile pages. Lives in its own table so auth, email,
    // rewards, notifications, and analytics queries remain ghost-free by
    // construction (none of those touch ghost_users / ghost_game_history).
    //
    // mp_players.ghost_user_id and mp_leaderboard.ghost_user_id are nullable
    // FK columns: at most one of (user_id, ghost_user_id) is set per row.
    // The "one of" invariant is enforced at the insert helpers
    // (roomManager.addBots / ghostUsers.seatGhost) rather than via a CHECK
    // constraint because SQLite ALTER TABLE can't add a CHECK retroactively
    // without a full table recreate.
    version: 51,
    sql: `
      CREATE TABLE IF NOT EXISTS ghost_users (
        id                     TEXT PRIMARY KEY,
        username               TEXT NOT NULL UNIQUE,
        username_normalized    TEXT NOT NULL UNIQUE,
        avatar                 TEXT NOT NULL,
        lifetime_score         INTEGER NOT NULL DEFAULT 0,
        account_created_at     TEXT NOT NULL,
        on_shift               INTEGER NOT NULL DEFAULT 0,
        shift_started_at       TEXT,
        shift_ends_at          TEXT,
        on_break_until         TEXT,
        is_active              INTEGER NOT NULL DEFAULT 1,
        -- Activity tracking for the cycling-out lifecycle. Updated by
        -- creditGhostScore on every credited round.
        last_played_at         TEXT,
        -- Synthetic daily streak, mirroring users.daily_streak_*. Advanced
        -- probabilistically once per UTC day for active on-shift ghosts so
        -- the streak leaderboard isn't all real-user.
        daily_streak_current   INTEGER NOT NULL DEFAULT 0,
        daily_streak_best      INTEGER NOT NULL DEFAULT 0,
        daily_streak_last_date TEXT,
        created_at             TEXT NOT NULL,
        updated_at             TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_ghost_users_on_shift
        ON ghost_users(on_shift) WHERE on_shift = 1;
      CREATE INDEX IF NOT EXISTS idx_ghost_users_active
        ON ghost_users(is_active) WHERE is_active = 1;
      CREATE INDEX IF NOT EXISTS idx_ghost_users_lifetime
        ON ghost_users(lifetime_score DESC);

      ALTER TABLE mp_players      ADD COLUMN ghost_user_id TEXT REFERENCES ghost_users(id);
      ALTER TABLE mp_leaderboard  ADD COLUMN ghost_user_id TEXT REFERENCES ghost_users(id);
      CREATE INDEX IF NOT EXISTS idx_mp_players_ghost
        ON mp_players(ghost_user_id) WHERE ghost_user_id IS NOT NULL;

      CREATE TABLE IF NOT EXISTS ghost_game_history (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        ghost_user_id   TEXT NOT NULL REFERENCES ghost_users(id) ON DELETE CASCADE,
        game_type       TEXT NOT NULL,
        game_mode       TEXT NOT NULL,
        room_code       TEXT,
        score           INTEGER NOT NULL,
        placement       INTEGER,
        players_count   INTEGER,
        played_at       TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_ghost_game_history
        ON ghost_game_history(ghost_user_id, played_at DESC);
    `,
  },
  {
    // Lobby-invite reward system. Strictly separate from the signup-referral
    // tables (referrals, etc.) — different reward shape (gameplay buff vs
    // giveaway entry) and different anti-abuse rules.
    //
    // mp_invite_tokens: opaque tokens minted by a host so we can attribute a
    // join back to them without exposing the inviter's identity in the URL.
    // mp_invite_attributions: one row per (token, joiner) pair; records both
    // earned rewards and silent rejects for analytics + dedup.
    // mp_pending_buffs: outstanding score multipliers; consumed by the round
    // scoring path. Decoupled so future reward types reuse the consumer.
    //
    // user_game_history gains was_buffed + raw_score so analytics can split
    // ranked-pure vs buffed history without a backfill.
    //
    // Renumbered to v52 during the second rebase: main landed v48
    // (giveaway_loss), v49 (auto-lobby), v50 (admin leaderboard moderation),
    // and v51 (ghost users) ahead of this PR. Migration versions are
    // forward-only and unique, so the multiplayer-invite tables sit at the
    // next free slot.
    version: 52,
    sql: `
      CREATE TABLE IF NOT EXISTS mp_invite_tokens (
        token              TEXT PRIMARY KEY,
        room_code          TEXT NOT NULL,
        inviter_user_id    TEXT,
        inviter_visitor_id TEXT NOT NULL,
        inviter_ip         TEXT NOT NULL,
        inviter_fp         TEXT,
        created_at         INTEGER NOT NULL,
        revoked_at         INTEGER,
        FOREIGN KEY (room_code) REFERENCES mp_rooms(code) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_invite_tokens_room
        ON mp_invite_tokens(room_code);
      CREATE INDEX IF NOT EXISTS idx_invite_tokens_inviter_user
        ON mp_invite_tokens(inviter_user_id);
      CREATE INDEX IF NOT EXISTS idx_invite_tokens_inviter_visitor
        ON mp_invite_tokens(inviter_visitor_id);

      CREATE TABLE IF NOT EXISTS mp_invite_attributions (
        id                  INTEGER PRIMARY KEY AUTOINCREMENT,
        token               TEXT NOT NULL,
        room_code           TEXT NOT NULL,
        joiner_player_id    TEXT NOT NULL,
        joiner_user_id      TEXT,
        joiner_visitor_id   TEXT NOT NULL,
        joiner_ip           TEXT NOT NULL,
        joiner_fp           TEXT,
        joiner_identity_key TEXT NOT NULL,
        status              TEXT NOT NULL,
        reject_reason       TEXT,
        rounds_completed    INTEGER NOT NULL DEFAULT 0,
        created_at          INTEGER NOT NULL,
        earned_at           INTEGER,
        FOREIGN KEY (token) REFERENCES mp_invite_tokens(token) ON DELETE CASCADE,
        FOREIGN KEY (room_code) REFERENCES mp_rooms(code) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_attr_token_status
        ON mp_invite_attributions(token, status, earned_at);
      CREATE INDEX IF NOT EXISTS idx_attr_pair_recent
        ON mp_invite_attributions(joiner_identity_key, created_at);
      CREATE INDEX IF NOT EXISTS idx_attr_joiner_player
        ON mp_invite_attributions(joiner_player_id);

      CREATE TABLE IF NOT EXISTS mp_pending_buffs (
        id                     INTEGER PRIMARY KEY AUTOINCREMENT,
        beneficiary_user_id    TEXT,
        beneficiary_visitor_id TEXT NOT NULL,
        source                 TEXT NOT NULL,
        attribution_id         INTEGER NOT NULL,
        multiplier             REAL NOT NULL,
        matches_remaining      INTEGER NOT NULL,
        expires_at             INTEGER NOT NULL,
        created_at             INTEGER NOT NULL,
        FOREIGN KEY (attribution_id) REFERENCES mp_invite_attributions(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_buffs_user_active
        ON mp_pending_buffs(beneficiary_user_id, matches_remaining);
      CREATE INDEX IF NOT EXISTS idx_buffs_visitor_active
        ON mp_pending_buffs(beneficiary_visitor_id, matches_remaining);

      ALTER TABLE user_game_history ADD COLUMN was_buffed INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE user_game_history ADD COLUMN raw_score INTEGER;
    `,
  },
  {
    // Move row-level leaderboard moderation onto `user_game_history` — the
    // table that actually feeds the v2 lifetime board. The legacy
    // `leaderboard` table fed the abandoned per-mode top-20 board and was
    // missing most active users (only rows from explicit
    // `POST /:sessionId/leaderboard` calls), so excluding rows there had no
    // visible effect on what players actually saw. Drop it and the empty
    // moderation columns it carried.
    //
    // The `admin_leaderboard_audit` rows produced before this migration
    // still reference legacy `leaderboard.id` values via `target_id`; we
    // leave those intact because they are a historical record and the
    // moderation panel reads them as opaque strings.
    version: 53,
    sql: `
      ALTER TABLE user_game_history ADD COLUMN excluded_at TEXT;
      ALTER TABLE user_game_history ADD COLUMN excluded_by_admin_id TEXT;
      ALTER TABLE user_game_history ADD COLUMN excluded_reason TEXT;

      CREATE INDEX IF NOT EXISTS idx_user_game_history_excluded
        ON user_game_history(excluded_at);

      DROP TABLE IF EXISTS leaderboard;
    `,
  },
  {
    // Loosen mp_pending_buffs.attribution_id to be nullable so non-invite
    // buff sources (e.g. `public_game`, future `idle_rush`) can grant
    // buffs without an associated mp_invite_attributions row. SQLite
    // doesn't support `ALTER TABLE ... DROP NOT NULL`, so the standard
    // pattern is rebuild → copy → drop → rename → reindex. The FK to
    // mp_invite_attributions is preserved so existing invite buffs
    // still cascade-delete with their attribution rows.
    version: 54,
    sql: `
      CREATE TABLE mp_pending_buffs_new (
        id                     INTEGER PRIMARY KEY AUTOINCREMENT,
        beneficiary_user_id    TEXT,
        beneficiary_visitor_id TEXT NOT NULL,
        source                 TEXT NOT NULL,
        attribution_id         INTEGER,
        multiplier             REAL NOT NULL,
        matches_remaining      INTEGER NOT NULL,
        expires_at             INTEGER NOT NULL,
        created_at             INTEGER NOT NULL,
        FOREIGN KEY (attribution_id) REFERENCES mp_invite_attributions(id) ON DELETE CASCADE
      );

      INSERT INTO mp_pending_buffs_new
        (id, beneficiary_user_id, beneficiary_visitor_id, source,
         attribution_id, multiplier, matches_remaining, expires_at, created_at)
      SELECT
         id, beneficiary_user_id, beneficiary_visitor_id, source,
         attribution_id, multiplier, matches_remaining, expires_at, created_at
        FROM mp_pending_buffs;

      DROP TABLE mp_pending_buffs;
      ALTER TABLE mp_pending_buffs_new RENAME TO mp_pending_buffs;

      CREATE INDEX IF NOT EXISTS idx_buffs_user_active
        ON mp_pending_buffs(beneficiary_user_id, matches_remaining);
      CREATE INDEX IF NOT EXISTS idx_buffs_visitor_active
        ON mp_pending_buffs(beneficiary_visitor_id, matches_remaining);
    `,
  },
  {
    // Per-ghost daily-play probability for the daily-challenge simulator.
    // Each ghost carries a stable per-day "would I play the daily today"
    // probability so streak distributions vary across the population
    // (some ghosts streak hard, others sporadic). Backfill default 0.7
    // matches the prior global constant so existing ghosts behave
    // identically until the daily-sim ships.
    version: 55,
    sql: `
      ALTER TABLE ghost_users ADD COLUMN daily_play_probability REAL NOT NULL DEFAULT 0.7;
    `,
  },
  {
    // Per-ghost decision marker for the daily-play simulator. Records the
    // UTC date of the most recent decision (play OR no-play) so the
    // simulator can run on every hourly tick without double-counting:
    // ghosts that already decided today are skipped, regardless of which
    // tick made the decision. Combined with the new on-shift filter, this
    // makes ghost daily plays trickle out across the day in lock-step
    // with shift rotation rather than firing in one all-at-once burst.
    version: 56,
    sql: `
      ALTER TABLE ghost_users ADD COLUMN last_daily_decision_date TEXT;
    `,
  },
  {
    // join_source records how the player ended up in this room — share-link
    // landing, lobby browser, quickplay matchmaking, or room creation.
    // Forward-only: existing rows are NULL (legacy/unknown). Populated on
    // insert by roomManager.createRoom / joinRoom; never mutated after.
    //
    // Renumbered to v57 during the third rebase: main landed v54
    // (mp_pending_buffs loosening), v55 + v56 (ghost daily-play simulator)
    // ahead of this PR.
    version: 57,
    sql: `
      ALTER TABLE mp_players ADD COLUMN join_source TEXT;
      CREATE INDEX IF NOT EXISTS idx_mp_players_join_source
        ON mp_players(join_source) WHERE join_source IS NOT NULL;
    `,
  },
  {
    // Backfilled / synthesized events flag — reconstructs historical game
    // counts (mp_game_completed, mp_room_created, daily_completed) from the
    // pre-existing gameplay tables (mp_leaderboard, mp_rooms, daily_plays)
    // so v2 dashboards aren't artificially zero before the instrumentation
    // landed. Headline count metrics include synthetic rows by default;
    // retention / funnel / device / geo queries exclude them since they
    // carry no session, device, or attribution context. Indexed because
    // the exclusion query (`is_synthetic = 0`) runs on every retention /
    // cohort / funnel read.
    version: 58,
    sql: `
      ALTER TABLE events ADD COLUMN is_synthetic INTEGER NOT NULL DEFAULT 0;
      CREATE INDEX IF NOT EXISTS idx_events_synthetic
        ON events(is_synthetic) WHERE is_synthetic = 1;
    `,
  },
  {
    // Per-game UUID stamped on each `lobby → playing` transition. Used as a
    // disambiguator in deterministic `client_event_id`s for game-level
    // events (`mp_game_started`, `mp_game_completed`, daily MP completion).
    //
    // Why this is needed: `mp_rooms.code` is reused across "Play Again",
    // and `created_at` doesn't change on reset, so without an explicit
    // game id a dedup key like `<roomCode>:<eventName>` would silently
    // suppress the second-game completion as a duplicate of the first.
    // The column is set fresh at every lobby→playing transition (see
    // `mpRoundStart.ts`) and cleared on `roomManager.resetRoom`. NULL is
    // the lobby/finished resting state; non-NULL means a game is in
    // progress under that id. Forward-only — pre-migration rows stay
    // NULL; the keying logic falls back to `<roomCode>:<created_at>` for
    // those legacy rooms (deterministic, no churn).
    version: 59,
    sql: `
      ALTER TABLE mp_rooms ADD COLUMN current_game_id TEXT;
    `,
  },
  {
    // Persist the visitor's last-known DNT/GPC preference on visitor_profile.
    // Server-emitted events fired outside a request context (mpRoundEnd round
    // timer, mpRoundStart on lobby→playing, recordDailyPlaysForRoom) have no
    // headers to read DNT from — without this column they'd silently emit
    // full-fidelity rows for visitors who explicitly opted out via DNT/GPC.
    //
    // The column is updated by recordEventFromRequest on every HTTP-bound
    // event; downstream emitters read it at emit time and pass it through
    // recordEvent so the dnt-scrub branch in recordEvent applies. NULL means
    // unknown / never observed (treated as opt-in by recordEvent's existing
    // logic).
    version: 60,
    sql: `
      ALTER TABLE visitor_profile ADD COLUMN dnt INTEGER;
    `,
  },
  {
    // PR1 perf F1: partial indexes that turn the leaderboard-availability
    // probe from a full per-user GROUP-BY scan into three indexed EXISTS
    // checks. Without these the optimizer fell back to scanning the
    // excluded_at index which matched almost every row. The
    // played_at-ordered partial index lets each "is there ≥1 scoring play
    // in this rolling window?" check resolve at the first qualifying row.
    version: 61,
    sql: `
      CREATE INDEX IF NOT EXISTS idx_user_game_history_played_active
        ON user_game_history(played_at)
        WHERE excluded_at IS NULL;

      CREATE INDEX IF NOT EXISTS idx_ghost_game_history_played
        ON ghost_game_history(played_at);
    `,
  },
  {
    // PR1 perf F2: cache `total_games` on users so the lifetime-leaderboard
    // query no longer needs a LEFT JOIN onto user_game_history with a
    // GROUP BY on user_id. The cached column is bumped by the existing
    // record-game and excludeEntry/restoreEntry code paths (each already
    // wraps its mutation in a transaction with the lifetime_score update,
    // so the new increment slots into the same atomic block).
    //
    // Backfill counts only non-excluded rows so the column is consistent
    // with the leaderboard query's `excluded_at IS NULL` join condition.
    //
    // The new partial index covers the lifetime-board pagination's
    // ORDER BY pair (lifetime_score DESC, username ASC) with the same
    // filter set, so the query can walk the index without a temp B-tree
    // for ORDER BY.
    version: 62,
    sql: `
      ALTER TABLE users ADD COLUMN total_games INTEGER NOT NULL DEFAULT 0;

      UPDATE users SET total_games = COALESCE((
        SELECT COUNT(*)
          FROM user_game_history ugh
         WHERE ugh.user_id = users.id
           AND ugh.excluded_at IS NULL
      ), 0);

      CREATE INDEX IF NOT EXISTS idx_users_leaderboard
        ON users(lifetime_score DESC, username ASC)
        WHERE is_active = 1
          AND lifetime_score > 0
          AND leaderboard_banned_at IS NULL
          AND is_test_account = 0;
    `,
  },
  {
    // PR1 perf F5: partial index covering the streaks-leaderboard
    // ORDER BY (daily_streak_best DESC) over the same row set the query
    // filters. Without it the streaks endpoint did a full users-table
    // scan + sort. Borderline at current dataset size (4ms p99) but
    // the index is tiny (only users with a real streak best) and
    // future-proofs the query as the user base grows.
    version: 63,
    sql: `
      CREATE INDEX IF NOT EXISTS idx_users_streak_best
        ON users(daily_streak_best DESC)
        WHERE daily_streak_best > 0
          AND is_active = 1
          AND leaderboard_banned_at IS NULL
          AND is_test_account = 0;
    `,
  },
  {
    // 30-day claim window for awarded rewards. Adds per-award token (so the
    // email link is the canonical claim path), claim_expires_at, and
    // soft-void columns so an unclaimed reward can be returned to the pool
    // after 30 days while preserving the audit row. The original
    // UNIQUE(reward_id) column constraint is replaced by a partial unique
    // index that only applies to non-voided rows — this lets the same pool
    // row be re-awarded after a prior award is voided.
    //
    // Backfill: existing pending awards get a fresh 30-day window from the
    // migration timestamp (not awarded_at + 30d) so users mid-flight aren't
    // surprised by retroactive expiry. New tokens are generated using
    // SQLite's randomblob; subsequent awards use Node's crypto.randomBytes.
    version: 64,
    sql: `
      CREATE TABLE reward_awards_new (
        id TEXT PRIMARY KEY,
        reward_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        award_method TEXT NOT NULL,
        award_criteria TEXT,
        awarded_at TEXT NOT NULL,
        awarded_by TEXT NOT NULL,
        claimed_at TEXT,
        claim_token TEXT NOT NULL,
        claim_expires_at TEXT NOT NULL,
        voided_at TEXT,
        reminder_15d_sent_at TEXT,
        reminder_7d_sent_at TEXT,
        reminder_1d_sent_at TEXT,
        expired_email_sent_at TEXT,
        FOREIGN KEY (reward_id) REFERENCES reward_pool(id),
        FOREIGN KEY (user_id) REFERENCES users(id),
        FOREIGN KEY (awarded_by) REFERENCES admin_users(id)
      );

      INSERT INTO reward_awards_new
        (id, reward_id, user_id, award_method, award_criteria,
         awarded_at, awarded_by, claimed_at,
         claim_token, claim_expires_at, voided_at,
         reminder_15d_sent_at, reminder_7d_sent_at, reminder_1d_sent_at,
         expired_email_sent_at)
      SELECT
         id, reward_id, user_id, award_method, award_criteria,
         awarded_at, awarded_by, claimed_at,
         lower(hex(randomblob(24))),
         strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+30 days'),
         NULL, NULL, NULL, NULL, NULL
      FROM reward_awards;

      DROP TABLE reward_awards;
      ALTER TABLE reward_awards_new RENAME TO reward_awards;

      CREATE INDEX IF NOT EXISTS idx_reward_awards_user
        ON reward_awards(user_id);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_reward_awards_active_reward
        ON reward_awards(reward_id) WHERE voided_at IS NULL;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_reward_awards_claim_token
        ON reward_awards(claim_token);
      CREATE INDEX IF NOT EXISTS idx_reward_awards_pending_expiry
        ON reward_awards(claim_expires_at)
        WHERE voided_at IS NULL AND claimed_at IS NULL;
    `,
  },
  {
    // Two-phase roll: a random-roll first writes a "pending review" award
    // row so the admin can confirm the winner before any notification
    // emails fire. While `pending_review_at` is set, the row exists in the
    // DB (so the partial-unique index on reward_id is held) but the
    // winner/non-winner emails have NOT been sent and the claim window
    // hasn't been counted from yet — the deadline starts on confirmation.
    //
    // A pending row is identified by:
    //   pending_review_at IS NOT NULL
    //   AND voided_at IS NULL
    //   AND claimed_at IS NULL
    version: 65,
    sql: `
      ALTER TABLE reward_awards ADD COLUMN pending_review_at TEXT;
    `,
  },
  {
    // System-managed UTM tags for outbound link tagging.
    //
    // Auto-generated short codes for each email/push template type are
    // stored as utm_tags rows tagged with `origin_key`. The partial unique
    // index keeps one row per (origin_key, destination_url) so the
    // tagging service can INSERT-OR-IGNORE concurrently without producing
    // duplicates, while admin-created tags (origin_key IS NULL) keep their
    // existing freedom to share UTM tuples.
    //
    // `created_by` is already nullable so no further migration is needed
    // — system rows are inserted with NULL creator.
    version: 66,
    sql: `
      ALTER TABLE utm_tags ADD COLUMN origin_key TEXT;

      CREATE UNIQUE INDEX IF NOT EXISTS idx_utm_tags_origin_dest
        ON utm_tags(origin_key, destination_url)
        WHERE origin_key IS NOT NULL;
    `,
  },
  {
    // Per-seat marker for the streamer-bot. Set during joinRoom when the
    // joining socket carried a valid X-Streamer-Bot shared-secret header.
    // Read by mpRoundEnd / mpRoundStart to skip analytics emits +
    // user_game_history / mp_leaderboard writes for the bot's seat without
    // touching is_bot (which controls server-side AI decision-making).
    version: 67,
    sql: `
      ALTER TABLE mp_players ADD COLUMN is_streamer_bot INTEGER NOT NULL DEFAULT 0;
    `,
  },
  {
    // Streamer-bot relay state — persists the latest stats and music
    // payloads pushed by the bot so a server restart (deploy, OOM,
    // container kill) doesn't blank the broadcast overlay until the
    // next bot round / track change. Singleton row keyed by id=1; the
    // `streamer.ts` route hydrates from this on startup and writes back
    // on every POST. JSON columns rather than typed columns so future
    // payload-shape additions don't need another migration.
    version: 68,
    sql: `
      CREATE TABLE IF NOT EXISTS streamer_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        stats_json TEXT,
        music_json TEXT,
        stats_updated_at INTEGER,
        music_updated_at INTEGER
      );
      INSERT OR IGNORE INTO streamer_state (id) VALUES (1);
    `,
  },
  {
    // Win/Loss/Streak tracker. Cached counters live on `users` and
    // `visitor_attribution` so the in-game HUD can read in O(1). The
    // signed `current_streak` increments on a win, decrements on a loss,
    // and flips through zero. `is_win` on `user_game_history` is the
    // append-only source of truth for backfill / per-mode breakdowns;
    // NULL = "didn't count" (disconnect, solo MP room, bot, excluded).
    // `users.is_bot` lets the streamer-bot user (and any future bots)
    // skip the W/L counters without affecting their analytics rows.
    version: 69,
    sql: `
      ALTER TABLE users ADD COLUMN lifetime_wins   INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE users ADD COLUMN lifetime_losses INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE users ADD COLUMN current_streak  INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE users ADD COLUMN best_win_streak INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE users ADD COLUMN is_bot          INTEGER NOT NULL DEFAULT 0;

      ALTER TABLE visitor_attribution ADD COLUMN lifetime_wins   INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE visitor_attribution ADD COLUMN lifetime_losses INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE visitor_attribution ADD COLUMN current_streak  INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE visitor_attribution ADD COLUMN best_win_streak INTEGER NOT NULL DEFAULT 0;

      ALTER TABLE user_game_history ADD COLUMN is_win INTEGER;
    `,
  },
  {
    // Mood-engine v2 persistence — extends `streamer_state` with a
    // serialised MoodSnapshot so a container restart hydrates Pricey's
    // emotional arc (mood label + hidden vibe + hidden morale + signed
    // round streak) instead of resetting to neutral. Same singleton
    // row + JSON column pattern as the v68 stats/music slots so future
    // engine-shape additions don't need another migration. The runner
    // POSTs the snapshot through after every `nextMood` call (debounced)
    // and the route writes through to this column.
    version: 70,
    sql: `
      ALTER TABLE streamer_state ADD COLUMN mood_json TEXT;
      ALTER TABLE streamer_state ADD COLUMN mood_updated_at INTEGER;
    `,
  },
];

function getCurrentVersion(database: DatabaseType): number {
  const row = database
    .prepare("SELECT MAX(version) as v FROM schema_version")
    .get() as { v: number | null } | undefined;
  return row?.v ?? 0;
}

function runMigrations(database: DatabaseType): void {
  // Wrap the version check AND every ALTER/INSERT in a single IMMEDIATE
  // transaction. Without this, two processes loading db.ts concurrently
  // (e.g. CI running vitest workers in parallel) can both read
  // `schema_version = 0`, both start applying v1, and the second one hits
  // "duplicate column name" because the first already added it. Per
  // better-sqlite3 semantics, calling `.immediate()` on a transaction
  // function issues `BEGIN IMMEDIATE` which acquires a RESERVED lock up
  // front; other writers wait on `busy_timeout=5000`. Re-reading the
  // version inside the transaction ensures we never repeat a migration.
  const apply = database.transaction(() => {
    const current = getCurrentVersion(database);
    for (const migration of migrations) {
      if (migration.version <= current) continue;
      database.exec(migration.sql);
      database
        .prepare("INSERT INTO schema_version (version) VALUES (?)")
        .run(migration.version);
    }
  });
  apply.immediate();
}

// For existing databases that already have these columns but no schema_version rows,
// detect and mark migrations as applied.
function bootstrapExistingDb(database: DatabaseType): void {
  const current = getCurrentVersion(database);
  if (current > 0) return; // Already tracked

  // Check if migration 1 columns already exist
  const columns = database
    .prepare("PRAGMA table_info(game_sessions)")
    .all() as { name: string }[];
  const hasGameMode = columns.some((c) => c.name === "game_mode");

  if (hasGameMode) {
    // Columns exist from old try/catch migrations — only mark the migrations
    // that correspond to the original pre-migration schema (v1-v3) as applied.
    // Newer migrations (v4+) must still run to add new tables/columns.
    const PRE_MIGRATION_VERSIONS = [1, 2, 3];
    const markApplied = database.prepare("INSERT OR IGNORE INTO schema_version (version) VALUES (?)");
    database.transaction(() => {
      for (const version of PRE_MIGRATION_VERSIONS) {
        markApplied.run(version);
      }
    })();
  }
}

bootstrapExistingDb(db);
runMigrations(db);

// Backfill referral codes for users that don't have one (after v26 migration)
try {
  const { backfillReferralCodes } = require("./services/referrals");
  const backfilled = backfillReferralCodes(db);
  if (backfilled > 0) {
    console.log(`Backfilled referral codes for ${backfilled} users`);
  }
} catch {
  // Silently skip if referrals module isn't available (e.g. during build)
}

// Seed default legal documents (uses parameterized queries to avoid SQL injection
// issues with markdown content containing special characters like #, ', etc.)
function seedLegalDocuments(database: DatabaseType): void {
  const now = new Date().toISOString();
  const stmt = database.prepare(
    `INSERT OR IGNORE INTO site_settings (key, value, updated_at) VALUES (?, ?, ?)`
  );
  stmt.run("legal_privacy_policy", JSON.stringify(DEFAULT_PRIVACY_POLICY), now);
  stmt.run("legal_terms_of_service", JSON.stringify(DEFAULT_TERMS_OF_SERVICE), now);
}

try {
  seedLegalDocuments(db);
} catch (err) {
  console.error("Failed to seed legal documents:", err);
}

export default db;
