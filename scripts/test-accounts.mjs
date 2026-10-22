// Test fixture identities only. Production never accepts a password as a legacy bearer credential.
const accounts=new Map()
export function rememberTestAccount(key,account){accounts.set(key,account)}
export function testAccount(key){const value=accounts.get(key);if(!value)throw new Error('Unknown test identity');return value}
