'use strict';

const { DeviceManagement } = require('@iobroker/dm-utils');

const ICON =
    'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCA2NCA2NCI+CiAgPHJlY3Qgd2lkdGg9IjY0IiBoZWlnaHQ9IjY0IiByeD0iMTQiIGZpbGw9IiNlM2U5ZWYiLz4KICA8cmVjdCB4PSIxNyIgeT0iOCIgd2lkdGg9IjMwIiBoZWlnaHQ9IjQ4IiByeD0iNSIgZmlsbD0iI2ZmZiIgc3Ryb2tlPSIjMGYxNDE5IiBzdHJva2Utd2lkdGg9IjMiLz4KICA8Y2lyY2xlIGN4PSIzMiIgY3k9IjE5IiByPSI0IiBmaWxsPSIjMGYxNDE5Ii8+CiAgPGNpcmNsZSBjeD0iMzIiIGN5PSIzOCIgcj0iMTAiIGZpbGw9Im5vbmUiIHN0cm9rZT0iIzBmMTQxOSIgc3Ryb2tlLXdpZHRoPSIzIi8+CiAgPGNpcmNsZSBjeD0iMzIiIGN5PSIzOCIgcj0iMyIgZmlsbD0iIzBmMTQxOSIvPgo8L3N2Zz4K';

/**
 * Lists the amplifiers in the admin's device manager: connection status,
 * address, and details such as model, serial number and firmware.
 */
class ArylicDeviceManagement extends DeviceManagement {
    /**
     * @returns {import('@iobroker/dm-utils').InstanceDetails} instance information
     */
    getInstanceInfo() {
        return {
            ...super.getInstanceInfo(),
            identifierLabel: { en: 'IP address', de: 'IP-Adresse' },
        };
    }

    /**
     * @param {import('@iobroker/dm-utils').DeviceLoadContext<string>} context collects the devices
     */
    loadDevices(context) {
        const devices = [...this.adapter.devices.values()];
        context.setTotalDevices(devices.length);
        for (const device of devices) {
            context.addDevice({
                id: device.id,
                identifier: device.host,
                name: device.name,
                icon: ICON,
                manufacturer: 'Arylic',
                model: device.info.model,
                status: device.connected ? 'connected' : 'disconnected',
                hasDetails: true,
                actions: [
                    {
                        id: 'refresh',
                        icon: 'refresh',
                        description: { en: 'Read all values now', de: 'Alle Werte jetzt lesen' },
                        handler: () => {
                            device.refresh();
                            return { refresh: 'none' };
                        },
                    },
                    {
                        id: 'web',
                        icon: 'web',
                        description: { en: 'Open the web interface', de: 'Weboberfläche öffnen' },
                        url: `http://${device.host}`,
                    },
                ],
            });
        }
    }

    /**
     * @param {string} id device id
     * @returns {Promise<import('@iobroker/dm-utils').DeviceDetails<string>>} details shown below the device
     */
    async getDeviceDetails(id) {
        const device = this.adapter.devices.get(id);
        const rows = [
            ['Model', 'info.model'],
            ['Serial number', 'info.serial'],
            ['Firmware', 'info.firmware'],
            ['Amplifier chip', 'info.mcuVersion'],
            ['Input', 'source'],
            ['Volume', 'volume'],
            ['Maximum volume', 'maxVolume'],
        ];
        const items = {
            host: { type: 'staticText', text: `IP: ${device ? device.host : '?'}`, sm: 12 },
        };
        for (const [label, stateId] of rows) {
            const state = await this.adapter.getStateAsync(`${id}.${stateId}`);
            items[stateId.replace(/\./g, '_')] = {
                type: 'staticText',
                text: `${label}: ${state && state.val !== null ? state.val : '–'}`,
                sm: 12,
            };
        }
        return { id, schema: { type: 'panel', items } };
    }
}

module.exports = { ArylicDeviceManagement };
