import fs from 'node:fs';
import { gameCreatePreparationSource } from './gameCreatePreparationSource.mjs';
import { trainingBookingPreludeSource } from './trainingRegistrationOwnerSource.mjs';
const read = (path) => fs.readFileSync(new URL('../' + path, import.meta.url), 'utf8');
export const gameCreateOwnerPrelude = () => [
  read('nodered_booked_operation_receiver_nodes/_booked_operation_delegation_prelude.js'),
  read('nodered_game_create_preparation_nodes/_game_create_preparation_contract.js'),
  read('nodered_game_create_owner_nodes/_game_create_owner_contract.js'),
].join('\n');
export const gameCreateOwnerSource = (name) => name === 'observe'
  ? gameCreatePreparationSource('router')
  : gameCreateOwnerPrelude() + '\n' + read('nodered_game_create_owner_nodes/fn_game_create_owner_' + name + '.js');
export const quarterCreateSplitSource = (name) => gameCreateOwnerPrelude() + '\n'
  + read('nodered_game_create_owner_nodes/_game_create_owner_split.js') + '\n'
  + read('nodered_games_nodes/fn_split_' + name + '.js');
export const quarterCreateGatewaySource = () => gameCreateOwnerPrelude() + '\n'
  + read('nodered_game_create_owner_nodes/_game_create_owner_gateway.js') + '\n'
  + trainingBookingPreludeSource()
  + read('nodered_subscription_booking_nodes/fn_subscription_booking_owner_contract_probe.js')
  + read('nodered_subscription_booking_nodes/fn_subscription_booking_router.js');
