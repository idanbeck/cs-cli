// ASCII art weapon sprites for first-person view

export interface WeaponSprite {
  idle: string[];
  fire: string[];  // Muzzle flash frame
  reload?: string[];
  knife?: string[]; // Knife swing frames
}

// Pistol sprite
export const PISTOL_SPRITE: WeaponSprite = {
  idle: [
    '        _____',
    '       |     |',
    '   ____|_____|',
    '  |    ___   |',
    '  |   |   |  |',
    '  |___|   |__|',
    '      |   |',
    '      |___|',
  ],
  fire: [
    '      \\ | /',
    '     - ___ -',
    '       |     |',
    '   ____|_____|',
    '  |    ___   |',
    '  |   |   |  |',
    '  |___|   |__|',
    '      |___|',
  ],
};

// Rifle sprite
export const RIFLE_SPRITE: WeaponSprite = {
  idle: [
    '                    ___________',
    '    _______________/           \\',
    '   /              |    ===|    |',
    '  |   ____________|____________|',
    '  |  |',
    '  |__|',
    '   ||',
    '   ||',
  ],
  fire: [
    '              * * *',
    '               \\|/',
    '                    ___________',
    '    _______________/           \\',
    '   /              |    ===|    |',
    '  |   ____________|____________|',
    '  |__|',
    '   ||',
  ],
};

// Knife sprite
export const KNIFE_SPRITE: WeaponSprite = {
  idle: [
    '            /\\',
    '           /  \\',
    '          /    \\',
    '         /      \\',
    '        /   ||   \\',
    '       /    ||    \\',
    '            ||',
    '           [==]',
  ],
  fire: [  // Swing animation frame 1
    '                 /',
    '                /',
    '               /',
    '              /',
    '             /',
    '       _____/',
    '      [====]',
    '',
  ],
  knife: [  // Swing animation frame 2
    '      ____________',
    '     /            \\',
    '    /              \\',
    '   [================]',
    '',
    '',
    '',
    '',
  ],
};

// Shotgun sprite
export const SHOTGUN_SPRITE: WeaponSprite = {
  idle: [
    '              ________________',
    '    _________/                |',
    '   /        |     ====|      |',
    '  |   ______|_________________|',
    '  |  |    |',
    '  |__|    |',
    '   ||   \\_|',
    '   ||',
  ],
  fire: [
    '           * * * * *',
    '            \\|||||/',
    '              ________________',
    '    _________/                |',
    '   /        |     ====|      |',
    '  |   ______|_________________|',
    '  |__|    |',
    '   ||   \\_|',
  ],
};

// Sniper sprite
export const SNIPER_SPRITE: WeaponSprite = {
  idle: [
    '                          ___________',
    '    _____________________/           |',
    '   /    [O]             |    ===|    |',
    '  |   __________________|____________|',
    '  |  |',
    '  |__|',
    '   ||',
    '   ||',
  ],
  fire: [
    '                             *',
    '                            /',
    '                          ___________',
    '    _____________________/           |',
    '   /    [O]             |    ===|    |',
    '  |   __________________|____________|',
    '  |__|',
    '   ||',
  ],
};

// Simple hand sprite (shown behind weapon)
export const HANDS_SPRITE: string[] = [
  '     ___',
  '    /   \\',
  '   |     |___',
  '   |         \\',
  '    \\_________\\',
];

export function getWeaponSprite(weaponType: string): WeaponSprite {
  switch (weaponType) {
    case 'pistol': return PISTOL_SPRITE;
    case 'rifle': return RIFLE_SPRITE;
    case 'knife': return KNIFE_SPRITE;
    case 'shotgun': return SHOTGUN_SPRITE;
    case 'sniper': return SNIPER_SPRITE;
    default: return PISTOL_SPRITE;
  }
}
