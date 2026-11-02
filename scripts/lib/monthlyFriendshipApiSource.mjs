import fs from 'node:fs';
import { monthlyFriendshipApiRuntimeSource } from './monthlyFriendshipApi.mjs';
import { monthlyFriendshipCustodyRuntimeSource } from './monthlyFriendshipCustody.mjs';
import { monthlyFriendshipSource, monthlyCapacitySource } from './monthlyFriendshipSource.mjs';
const read = path => fs.readFileSync(new URL('../' + path, import.meta.url), 'utf8');
export const monthlyFriendshipApiSource = () => [
  monthlyFriendshipApiRuntimeSource(), monthlyFriendshipCustodyRuntimeSource(), monthlyCapacitySource(),
  'function monthlyPrivatePrepare(msg,global) {\n' + read('nodered_games_nodes/fn_tournament_subscription_purchase_prepare.js') + '\n}',
  'function monthlyPrivateProducts(msg,global) {\n' + monthlyFriendshipSource('purchase_router') + '\n}',
  'function monthlyPrivateAtomic(msg,global,env,node) {\n' + monthlyFriendshipSource('atomic') + '\n}',
  read('nodered_monthly_friendship_nodes/fn_monthly_friendship_api.js'),
].join('\n');
