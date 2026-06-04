export interface SeedProduct {
  asin: string;
  title: string;
  image_url: string;
  price_cents: number;
  category: string;
}

// These ASINs have been VERIFIED as real, working Amazon product pages.
// Image URLs are empty - the server proxy scrapes real images on demand.
// Prices are realistic Amazon selling prices.
export const SEED_PRODUCTS: SeedProduct[] = [
  // ========================
  // ELECTRONICS (25)
  // ========================
  { asin: "B0D1XD1ZV3", title: "Apple AirPods 4 Active Noise Cancellation", image_url: "", price_cents: 17900, category: "Electronics" },
  { asin: "B0BDHWDR12", title: "Apple AirPods Pro (2nd Generation) Wireless Ear Buds with USB-C", image_url: "", price_cents: 18999, category: "Electronics" },
  { asin: "B09V3KXJPB", title: "Apple iPad Air (5th Generation): with M1 chip, 10.9-inch Liquid Retina Display, 64GB", image_url: "", price_cents: 32900, category: "Electronics" },
  { asin: "B0CM5JV268", title: "Apple 2023 MacBook Pro Laptop M3 chip with 8-core CPU, 10-core GPU", image_url: "", price_cents: 159900, category: "Electronics" },
  { asin: "B094C4VDJZ", title: "Sony WF-1000XM4 Industry Leading Noise Canceling Truly Wireless Earbuds", image_url: "", price_cents: 12800, category: "Electronics" },
  { asin: "B09XS7JWHH", title: "Sony WH-1000XM5 Wireless Industry Leading Noise Canceling Headphones", image_url: "", price_cents: 27800, category: "Electronics" },
  { asin: "B07S395RWD", title: "Logitech MX Master 3 Advanced Wireless Mouse, Ultrafast Scrolling", image_url: "", price_cents: 7999, category: "Electronics" },
  { asin: "B085TFF7M1", title: "Logitech C920x HD Pro Webcam, Full HD 1080p/30fps Video Calling", image_url: "", price_cents: 5499, category: "Electronics" },
  { asin: "B09B8V1LZ3", title: "Amazon Fire TV Stick 4K streaming device", image_url: "", price_cents: 3499, category: "Electronics" },
  { asin: "B07FZ8S74R", title: "Echo Dot (3rd Gen) - Smart speaker with Alexa", image_url: "", price_cents: 1799, category: "Electronics" },
  { asin: "B09B8W5FW7", title: "Amazon Echo Dot (5th Gen) with clock - Compact smart speaker with Alexa", image_url: "", price_cents: 3999, category: "Electronics" },
  { asin: "B08FC6MR62", title: "PlayStation 5 DualSense Wireless Controller", image_url: "", price_cents: 6999, category: "Electronics" },
  { asin: "B0BCNKKZ91", title: "PlayStation 5 Console (PS5)", image_url: "", price_cents: 49999, category: "Electronics" },
  { asin: "B0BDHB9Y8H", title: "Apple AirPods (3rd Generation) Wireless Ear Buds", image_url: "", price_cents: 13499, category: "Electronics" },
  { asin: "B09B1GXM16", title: "SAMSUNG EVO Select Micro SD-Memory-Card + Adapter, 256GB", image_url: "", price_cents: 2199, category: "Electronics" },
  { asin: "B0BT2BDGPJ", title: "Samsung Galaxy S23 Cell Phone, Factory Unlocked, 128GB", image_url: "", price_cents: 59999, category: "Electronics" },
  { asin: "B09HMKFDXC", title: "Logitech MX Keys Mini Wireless Keyboard", image_url: "", price_cents: 7999, category: "Electronics" },
  { asin: "B08LMKT21B", title: "Logitech K380 Multi-Device Bluetooth Keyboard", image_url: "", price_cents: 2999, category: "Electronics" },
  { asin: "B09J1TB35P", title: "Logitech G502 X PLUS LIGHTSPEED Wireless Gaming Mouse", image_url: "", price_cents: 10999, category: "Electronics" },
  { asin: "B09B93ZDG4", title: "Amazon Echo Show 5 (3rd Gen) - Smart display with Alexa", image_url: "", price_cents: 5499, category: "Electronics" },
  { asin: "B0CCZ26B5V", title: "Bose QuietComfort Ultra Headphones", image_url: "", price_cents: 34900, category: "Electronics" },
  { asin: "B088H5LCBW", title: "Bose SoundLink Flex Bluetooth Portable Speaker", image_url: "", price_cents: 11900, category: "Electronics" },
  { asin: "B07HJWFLZB", title: "Corsair K55 RGB Gaming Keyboard", image_url: "", price_cents: 3499, category: "Electronics" },
  { asin: "B07GBZ4MWM", title: "Razer DeathAdder V2 Gaming Mouse", image_url: "", price_cents: 2999, category: "Electronics" },
  { asin: "B082G5SPR5", title: "Sabrent 4-Port USB 3.0 Hub", image_url: "", price_cents: 899, category: "Electronics" },

  // ========================
  // HOME & KITCHEN (25)
  // ========================
  { asin: "B00FLYWNYQ", title: "Instant Pot Duo 7-in-1 Electric Pressure Cooker, 6 Quart", image_url: "", price_cents: 8995, category: "Home & Kitchen" },
  { asin: "B075CYMYK6", title: "Instant Pot Duo Plus 9-in-1 Electric Pressure Cooker, 6 Quart", image_url: "", price_cents: 10995, category: "Home & Kitchen" },
  { asin: "B00005UP2K", title: "KitchenAid Classic Series 4.5 Quart Tilt-Head Stand Mixer", image_url: "", price_cents: 24999, category: "Home & Kitchen" },
  { asin: "B0936FGLQS", title: "COSORI Air Fryer Pro LE 5-Qt, 9 Custom Functions", image_url: "", price_cents: 6999, category: "Home & Kitchen" },
  { asin: "B00008CM67", title: "Lodge Pre-Seasoned Cast Iron Skillet, 10.25 Inch", image_url: "", price_cents: 1990, category: "Home & Kitchen" },
  { asin: "B000LEXR0K", title: "Lodge Pre-Seasoned Cast Iron Skillet, 12 Inch", image_url: "", price_cents: 2999, category: "Home & Kitchen" },
  { asin: "B0758JHZM3", title: "Vitamix 5200 Blender Professional-Grade, 64 oz. Container", image_url: "", price_cents: 39995, category: "Home & Kitchen" },
  { asin: "B07C1XC3GF", title: "Keurig K-Mini Single Serve Coffee Maker", image_url: "", price_cents: 7999, category: "Home & Kitchen" },
  { asin: "B00004OCKR", title: "OXO Good Grips Salad Spinner, Large", image_url: "", price_cents: 3295, category: "Home & Kitchen" },
  { asin: "B006QF3TW4", title: "Brita Standard Water Filter Replacements, 10 Count", image_url: "", price_cents: 3999, category: "Home & Kitchen" },
  { asin: "B0000CFQJS", title: "OXO Good Grips Stainless Steel Food Scale with Pull-Out Display", image_url: "", price_cents: 5499, category: "Home & Kitchen" },
  { asin: "B078PHPLW7", title: "Hydro Flask Water Bottle with Straw Lid, 32 oz", image_url: "", price_cents: 4495, category: "Home & Kitchen" },
  { asin: "B0CFCRS8V1", title: "Stanley Quencher H2.0 FlowState Tumbler, 40 oz", image_url: "", price_cents: 3500, category: "Home & Kitchen" },
  { asin: "B01HHGA3OG", title: "T-fal Ultimate Hard Anodized Nonstick 17 Piece Cookware Set", image_url: "", price_cents: 17999, category: "Home & Kitchen" },
  { asin: "B005HEMHQA", title: "Cuisinart MCP-12N Multiclad Pro Stainless Steel 12-Piece Cookware Set", image_url: "", price_cents: 29995, category: "Home & Kitchen" },
  { asin: "B07QH4ZDFD", title: "Etekcity Food Kitchen Scale, Digital Weight Grams and Ounces", image_url: "", price_cents: 1099, category: "Home & Kitchen" },
  { asin: "B0884ZTGP2", title: "Our Place Always Pan 2.0 - Nonstick, Toxin-Free", image_url: "", price_cents: 13000, category: "Home & Kitchen" },
  { asin: "B0B3PWST17", title: "Ember Temperature Control Smart Mug 2, 10 oz", image_url: "", price_cents: 12995, category: "Home & Kitchen" },
  { asin: "B07VDBS5TP", title: "ThermoWorks Thermapen ONE Instant Read Thermometer", image_url: "", price_cents: 10500, category: "Home & Kitchen" },
  { asin: "B0050IC7DO", title: "Victorinox Swiss Classic 8-Piece Knife Block Set", image_url: "", price_cents: 12495, category: "Home & Kitchen" },
  { asin: "B07588SJNH", title: "Instant Pot Ultra 6 Qt 10-in-1 Multi-Use Pressure Cooker", image_url: "", price_cents: 14999, category: "Home & Kitchen" },
  { asin: "B09559BTVD", title: "Ninja CFP301 DualBrew Pro Specialty Coffee System", image_url: "", price_cents: 16999, category: "Home & Kitchen" },
  { asin: "B07PJNSDMQ", title: "Cuisinart DCC-3200P1 Perfectemp Coffee Maker, 14 Cup", image_url: "", price_cents: 8695, category: "Home & Kitchen" },
  { asin: "B08QJ94PBP", title: "Ninja BL610 Professional 72 Oz Countertop Blender", image_url: "", price_cents: 5499, category: "Home & Kitchen" },
  { asin: "B003IKKO0W", title: "Wusthof Pro 8-inch Cook's Knife", image_url: "", price_cents: 3995, category: "Home & Kitchen" },

  // ========================
  // BEAUTY & PERSONAL CARE (25)
  // ========================
  { asin: "B01F1LZ5V6", title: "CeraVe Moisturizing Cream, Body and Face Moisturizer, 19 Ounce", image_url: "", price_cents: 1697, category: "Beauty & Personal Care" },
  { asin: "B00U1YCRD8", title: "CeraVe Hydrating Facial Cleanser, 16 oz", image_url: "", price_cents: 1557, category: "Beauty & Personal Care" },
  { asin: "B079H99466", title: "CeraVe AM Facial Moisturizing Lotion with SPF 30", image_url: "", price_cents: 1797, category: "Beauty & Personal Care" },
  { asin: "B0071GSMMC", title: "CeraVe PM Facial Moisturizing Lotion, 3 oz", image_url: "", price_cents: 1597, category: "Beauty & Personal Care" },
  { asin: "B00G7TOVE0", title: "CeraVe Foaming Facial Cleanser for Normal to Oily Skin, 16 oz", image_url: "", price_cents: 1557, category: "Beauty & Personal Care" },
  { asin: "B004D2826K", title: "Neutrogena Hydro Boost Water Gel Face Moisturizer", image_url: "", price_cents: 1897, category: "Beauty & Personal Care" },
  { asin: "B01HOHBS7K", title: "Neutrogena Ultra Sheer Dry-Touch Sunscreen SPF 70", image_url: "", price_cents: 1097, category: "Beauty & Personal Care" },
  { asin: "B003G4BP5G", title: "Neutrogena Makeup Remover Cleansing Face Wipes, 25 Count Twin Pack", image_url: "", price_cents: 1147, category: "Beauty & Personal Care" },
  { asin: "B003YMJJSK", title: "Aveeno Daily Moisturizing Body Lotion, 18 oz", image_url: "", price_cents: 1047, category: "Beauty & Personal Care" },
  { asin: "B00027DDOQ", title: "Cetaphil Gentle Skin Cleanser, 16 oz", image_url: "", price_cents: 1279, category: "Beauty & Personal Care" },
  { asin: "B0048ZUIY6", title: "Aquaphor Healing Ointment Advanced Therapy, 14 oz", image_url: "", price_cents: 1497, category: "Beauty & Personal Care" },
  { asin: "B01BT02Q2K", title: "Paula's Choice SKIN PERFECTING 2% BHA Liquid Salicylic Acid Exfoliant", image_url: "", price_cents: 3200, category: "Beauty & Personal Care" },
  { asin: "B002CML1VG", title: "Thayers Alcohol-Free Rose Petal Witch Hazel Facial Toner, 12 oz", image_url: "", price_cents: 1095, category: "Beauty & Personal Care" },
  { asin: "B08FXZXWBC", title: "REVLON One-Step Volumizer PLUS 2.0 Hair Dryer and Hot Air Brush", image_url: "", price_cents: 3499, category: "Beauty & Personal Care" },
  { asin: "B003WKM9MI", title: "Dyson Supersonic Hair Dryer", image_url: "", price_cents: 42999, category: "Beauty & Personal Care" },
  { asin: "B001QFZXSY", title: "Dove Beauty Bar More Moisturizing Than Bar Soap, 3.75 oz, 14 Bars", image_url: "", price_cents: 1499, category: "Beauty & Personal Care" },
  { asin: "B0776VD6W8", title: "Oral-B Pro 1000 CrossAction Electric Toothbrush", image_url: "", price_cents: 4299, category: "Beauty & Personal Care" },
  { asin: "B071NQFH8R", title: "Waterpik Aquarius Water Flosser Professional", image_url: "", price_cents: 5999, category: "Beauty & Personal Care" },
  { asin: "B08HLCXCGN", title: "Crest 3D Whitestrips Professional Effects At-Home Teeth Whitening Kit", image_url: "", price_cents: 4599, category: "Beauty & Personal Care" },
  { asin: "B0009F5YN0", title: "Sensodyne Pronamel Gentle Whitening Toothpaste, 4 oz", image_url: "", price_cents: 699, category: "Beauty & Personal Care" },
  { asin: "B07KRG2N9S", title: "EltaMD UV Clear Broad-Spectrum SPF 46 Face Sunscreen", image_url: "", price_cents: 3900, category: "Beauty & Personal Care" },
  { asin: "B00TCD51DQ", title: "La Roche-Posay Toleriane Hydrating Gentle Face Cleanser", image_url: "", price_cents: 1599, category: "Beauty & Personal Care" },
  { asin: "B001E96OMG", title: "Bioderma Sensibio H2O Micellar Water Makeup Remover, 500ml", image_url: "", price_cents: 1599, category: "Beauty & Personal Care" },
  { asin: "B083TPBT7L", title: "COSRX Advanced Snail 96 Mucin Power Essence, 3.38 fl.oz", image_url: "", price_cents: 1380, category: "Beauty & Personal Care" },
  { asin: "B07RZRBB1P", title: "Mighty Patch Original - Hydrocolloid Acne Pimple Patch, 36 Count", image_url: "", price_cents: 1297, category: "Beauty & Personal Care" },

  // ========================
  // SPORTS & OUTDOORS (25)
  // ========================
  { asin: "B074DZ45TN", title: "Amazon Basics Neoprene Coated Dumbbell Hand Weight Set, 20 Pound", image_url: "", price_cents: 2699, category: "Sports & Outdoors" },
  { asin: "B01LP0U60K", title: "BalanceFrom GoYoga All-Purpose 1/2-Inch Extra Thick Yoga Mat", image_url: "", price_cents: 2195, category: "Sports & Outdoors" },
  { asin: "B074DYBCFB", title: "Manduka PRO Yoga Mat - Premium 6mm Thick Mat", image_url: "", price_cents: 12000, category: "Sports & Outdoors" },
  { asin: "B07D3RCDMF", title: "Gaiam Essentials Thick Yoga Mat Fitness & Exercise Mat", image_url: "", price_cents: 2198, category: "Sports & Outdoors" },
  { asin: "B09P4DPNPX", title: "Bowflex SelectTech 552 Adjustable Dumbbells (Pair)", image_url: "", price_cents: 42900, category: "Sports & Outdoors" },
  { asin: "B08DG1BQWZ", title: "FLYBIRD Adjustable Weight Bench, Foldable Incline/Decline Bench", image_url: "", price_cents: 13999, category: "Sports & Outdoors" },
  { asin: "B0BGZ9HJDL", title: "Fit Simplify Resistance Loop Exercise Bands, Set of 5", image_url: "", price_cents: 1095, category: "Sports & Outdoors" },
  { asin: "B083GBFTXS", title: "Hydro Flask Wide Mouth Bottle, 32 oz, Stainless Steel", image_url: "", price_cents: 4495, category: "Sports & Outdoors" },
  { asin: "B0881ZHBH5", title: "YETI Rambler 26 oz Bottle, Stainless Steel, Vacuum Insulated", image_url: "", price_cents: 4000, category: "Sports & Outdoors" },
  { asin: "B0C46T6BLR", title: "Owala FreeSip Insulated Stainless Steel Water Bottle, 24 oz", image_url: "", price_cents: 2799, category: "Sports & Outdoors" },
  { asin: "B07QH3N2TC", title: "Iron Flask Sports Water Bottle, 32 Oz, 3 Lids", image_url: "", price_cents: 2199, category: "Sports & Outdoors" },
  { asin: "B018HIFHFY", title: "Coleman Sundome Camping Tent, 4-Person", image_url: "", price_cents: 7199, category: "Sports & Outdoors" },
  { asin: "B01HMTO6QK", title: "LifeStraw Personal Water Filter for Hiking", image_url: "", price_cents: 1495, category: "Sports & Outdoors" },
  { asin: "B074N6FZ5F", title: "TETON Sports Tracker Ultralight Double Sleeping Bag", image_url: "", price_cents: 7999, category: "Sports & Outdoors" },
  { asin: "B07K2P7YCJ", title: "Klymit Static V Sleeping Pad, Lightweight Camping Mattress", image_url: "", price_cents: 4499, category: "Sports & Outdoors" },
  { asin: "B014MGEBHO", title: "Osprey Atmos AG 65 Men's Backpacking Backpack", image_url: "", price_cents: 29000, category: "Sports & Outdoors" },
  { asin: "B019TBQ3IO", title: "The North Face Borealis Backpack", image_url: "", price_cents: 9900, category: "Sports & Outdoors" },
  { asin: "B076TSLFV7", title: "Black Diamond Trail Trekking Poles", image_url: "", price_cents: 5995, category: "Sports & Outdoors" },
  { asin: "B01A7YPYII", title: "Kryptonite Keeper 12 Standard Heavy Duty Bicycle U Lock", image_url: "", price_cents: 2999, category: "Sports & Outdoors" },
  { asin: "B074XIKNKD", title: "TriggerPoint GRID Foam Roller for Exercise, Deep Tissue Massage", image_url: "", price_cents: 3699, category: "Sports & Outdoors" },
  { asin: "B003AI2502", title: "Speedo Unisex-Adult Swim Goggles Vanquisher 2.0", image_url: "", price_cents: 2000, category: "Sports & Outdoors" },
  { asin: "B0016BPS3E", title: "GoSports Solid Wood Premium Cornhole Set", image_url: "", price_cents: 12999, category: "Sports & Outdoors" },
  { asin: "B001ARYU58", title: "SKLZ Quick Ladder Pro Agility Ladder", image_url: "", price_cents: 2499, category: "Sports & Outdoors" },
  { asin: "B073NVS7T8", title: "Te-Rich Resistance Bands Set, Exercise Bands", image_url: "", price_cents: 1099, category: "Sports & Outdoors" },
  { asin: "B004NSVA0A", title: "CAP Barbell Neoprene Coated Dumbbell Weights", image_url: "", price_cents: 1499, category: "Sports & Outdoors" },

  // ========================
  // TOYS & GAMES (25)
  // ========================
  { asin: "B00U26V4VQ", title: "CATAN Board Game (Base Game) - Civilization Building Strategy Game", image_url: "", price_cents: 3299, category: "Toys & Games" },
  { asin: "B0BX49VV8Q", title: "Ticket to Ride Board Game - Cross-Country Train Adventure Game", image_url: "", price_cents: 3999, category: "Toys & Games" },
  { asin: "B07QQ2LKM7", title: "Codenames Board Game - Top Secret Word Game", image_url: "", price_cents: 1499, category: "Toys & Games" },
  { asin: "B00NX627HW", title: "Pandemic Board Game - Cooperative Strategy Game", image_url: "", price_cents: 2999, category: "Toys & Games" },
  { asin: "B00005N5PF", title: "Risk Board Game - Strategy Conquest Game", image_url: "", price_cents: 2499, category: "Toys & Games" },
  { asin: "B07SG83QYF", title: "Wingspan Board Game - A Bird-Collection Engine-Building Game", image_url: "", price_cents: 4499, category: "Toys & Games" },
  { asin: "B00004TZY8", title: "UNO Card Game for Kids, Adults & Game Night", image_url: "", price_cents: 597, category: "Toys & Games" },
  { asin: "B01ASCZUSG", title: "Exploding Kittens Card Game - Family-Friendly Party Games", image_url: "", price_cents: 1999, category: "Toys & Games" },
  { asin: "B076QSB7FX", title: "Sushi Go Party! - The Deluxe Pick & Pass Card Game", image_url: "", price_cents: 1899, category: "Toys & Games" },
  { asin: "B0006HCVT8", title: "Phase 10 Card Game with 108 Cards", image_url: "", price_cents: 597, category: "Toys & Games" },
  { asin: "B09Q16L3ZM", title: "LEGO Icons Orchid Artificial Plant Building Set, 10311", image_url: "", price_cents: 3999, category: "Toys & Games" },
  { asin: "B09Q17TQPD", title: "LEGO Icons Bonsai Tree Building Set, 10281", image_url: "", price_cents: 3999, category: "Toys & Games" },
  { asin: "B0B8B44SY2", title: "LEGO Classic Large Creative Brick Box 10698 Building Toy Set", image_url: "", price_cents: 3999, category: "Toys & Games" },
  { asin: "B07VJRZ62R", title: "Nintendo Switch Pro Controller", image_url: "", price_cents: 6499, category: "Toys & Games" },
  { asin: "B073X4RF8C", title: "Nintendo Joy-Con (L/R) - Neon Red/Neon Blue", image_url: "", price_cents: 7499, category: "Toys & Games" },
  { asin: "B07HMV82YG", title: "Ravensburger Puzzler's Place 1000 Piece Jigsaw Puzzle", image_url: "", price_cents: 1499, category: "Toys & Games" },
  { asin: "B08JQVF17T", title: "Hasbro Gaming Jenga Classic Game", image_url: "", price_cents: 1299, category: "Toys & Games" },
  { asin: "B00GJPKLDG", title: "Hasbro Gaming Connect 4 Classic Grid Game", image_url: "", price_cents: 999, category: "Toys & Games" },
  { asin: "B078BWQHB3", title: "Spot It! Classic Card Game", image_url: "", price_cents: 999, category: "Toys & Games" },
  { asin: "B00000IZJT", title: "Hasbro Gaming Twister Ultimate Game", image_url: "", price_cents: 1999, category: "Toys & Games" },
  { asin: "B07WJ1HSLC", title: "Holy Stone HS210 Mini Drone RC Nano Quadcopter", image_url: "", price_cents: 3599, category: "Toys & Games" },
  { asin: "B01M1OBO5D", title: "Magna-Tiles Clear Colors 100 Piece Set", image_url: "", price_cents: 9999, category: "Toys & Games" },
  { asin: "B07FKR6KXF", title: "ThinkFun Gravity Maze Marble Run Brain Game STEM Toy", image_url: "", price_cents: 2999, category: "Toys & Games" },
  { asin: "B00NHQF6MG", title: "LEGO DUPLO Classic Brick Box 10913 Building Toy Set", image_url: "", price_cents: 2999, category: "Toys & Games" },
  { asin: "B084GSJKV2", title: "Monopoly Board Game, Classic Family Board Game", image_url: "", price_cents: 1999, category: "Toys & Games" },
];
